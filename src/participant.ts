// A Participant wraps one pi AgentSession (one persona) and exposes a simple
// run()/dispose() lifecycle. Its session keeps its own conversation memory
// across turns (stateful). The shared room transcript is threaded in by Room.

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent"
import { mkdirSync, readFileSync } from "node:fs"
import { access, readFile } from "node:fs/promises"
import { constants } from "node:fs"
import { join } from "node:path"
import { config } from "./config.js"
import { buildConfinedTools } from "./sandbox-tools.js"
import { buildCustomTools } from "./custom-tools/index.js"
import { resolveModelRef, type ResolvedModel } from "./model.js"
import type { RoomOrchestrator } from "./orchestrator.js"
import type { Persona, ParticipantStatus, ToolActivity } from "./types.js"

/** Cap a tool result/arg to keep SSE frames and persisted transcripts small. */
function clip(value: unknown, max = 2000): string {
  let s: string
  if (typeof value === "string") s = value
  else {
    try {
      s = JSON.stringify(value)
    } catch {
      s = String(value)
    }
  }
  return s.length > max ? `${s.slice(0, max)}… (+${s.length - max} chars)` : s
}

/** The workspace-scope note, parameterised by the room's actual root directory.
 *  A room scoped to the pipeline workspace gets the shared-workspace wording;
 *  a room scoped elsewhere (e.g. another project, or the machine root) is told
 *  exactly which directory its file tools are confined to. */
function workspaceNote(root: string): string {
  return (
    `Your working directory is ${root}. Use paths relative to it ` +
    "(e.g. `notes.md`, `src/app.ts`). Never read or write outside it — absolute paths " +
    "pointing outside this root are denied."
  )
}

const ROOM_NOTE =
  "You are one agent in a shared multi-agent chat room. Other agents are addressed by " +
  "@<id> in lowercase (e.g. @scout, @builder, @auditor, @scribe, @tester). To hand work " +
  "to another agent, write @<id> EXPLICITLY in your reply — a plain sentence like " +
  "'over to the builder' does NOT trigger anything. Only @-mention an agent when you " +
  "genuinely need it. Do not @-mention yourself, and do not use @all (that is for the human).\n" +
  "You can refer to other agents by name in discussion (e.g. 'the builder said...') without " +
  "triggering a handoff — only the @prefix routes work.\n" +
  "When handing off work to another agent, @-mention them in your reply — " +
  "any @mention triggers routing. Example: 'I've finished the analysis. @builder please implement " +
  "the fix above.'\n" +
  "If you need information only the user can provide (preferences, credentials, context), " +
  "use the ask_user tool — it will pause the pipeline and wait for their response. Do NOT " +
  "use it for rhetorical questions or self-clarification.\n" +
  "Your personal memory lives at agent_memory/<your_id>.md (e.g. agent_memory/builder.md). " +
  "Read it at the start of a task to recall prior context. The scribe updates these files. " +
  "After a compaction, your memory is refreshed automatically."

export type Emit = (event: "token" | "status" | "activity" | "reasoning", data: unknown) => void

/** What a turn produced: the final text plus the tool calls made to get there. */
export interface TurnResult {
  text: string
  activity: ToolActivity[]
  /** Reasoning trace accumulated during the turn. */
  reasoning?: string
  /** If the agent called ask_user, the question text. */
  question?: string
}

export class Participant {
  readonly persona: Persona
  active = true
  /** When true, may run concurrently with adjacent parallel-flagged agents. */
  parallel = false
  status: ParticipantStatus = "idle"
  /** Index of the next room transcript entry this participant has NOT yet seen. */
  cursor = 0
  /** True when the pi session was reopened from disk with prior conversation
   *  memory — the caller may then restore a saved cursor instead of replaying
   *  the whole room transcript on top of the restored context. */
  resumed = false
  /** On-disk pi session directory, when persistence is enabled. The registry
   *  removes it when the participant is kicked so a future agent with the same
   *  id does not inherit this one's memory. */
  sessionDir?: string

  private session!: AgentSession
  private unsubscribe: (() => void) | null = null
  private buffer = ""
  /** Tool calls made during the current turn, keyed for start/end matching. */
  private activity = new Map<string, ToolActivity>()
  /** Reasoning accumulated during the current turn. */
  private reasoningBuffer = ""
  private readonly emit: Emit
  /** The directory this participant's file tools are confined to. */
  private readonly workspaceDir: string

  private constructor(persona: Persona, emit: Emit, workspaceDir: string) {
    this.persona = persona
    this.emit = emit
    this.workspaceDir = workspaceDir
  }

  static async create(
    persona: Persona,
    resolved: ResolvedModel,
    emit: Emit,
    workspaceDir: string = config.workspaceDir,
    orchestrator?: RoomOrchestrator,
    defaultThinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" = config.thinkingLevel,
    allowCloud: boolean = config.allowCloud,
    compactionReserveTokens: number = 38000,
    /** Directory for the on-disk pi session (one per persona per conversation).
     *  Undefined → in-memory session, the pre-persistence behavior (tests). */
    sessionDir?: string,
  ): Promise<Participant> {
    const p = new Participant(persona, emit, workspaceDir)

    // Read agent memory (if it exists) — injected after the persona prompt.
    // Capped at 4KB to avoid consuming excessive context tokens.
    const memoryPath = join(workspaceDir, "agent_memory", `${persona.id}.md`)
    let memoryNote = ""
    try {
      await access(memoryPath, constants.R_OK)
      const raw = await readFile(memoryPath, "utf-8")
      const content = raw.length > 4096 ? raw.slice(0, 4096) + "… (truncated)" : raw
      memoryNote = `\nYOUR MEMORY (agent_memory/${persona.id}.md):\n${content}\n` +
        "---\n(End of memory — updated by the scribe. After compaction, this is refreshed.)\n"
    } catch {
      // No memory file — fine, first run or not yet populated.
    }

    const loader = new DefaultResourceLoader({
      cwd: workspaceDir,
      agentDir: getAgentDir(),
      // Append the persona to pi's default prompt so we keep tool-usage guidance.
      appendSystemPromptOverride: (base: string[]) => [
        ...base,
        persona.systemPrompt,
        workspaceNote(workspaceDir),
        ROOM_NOTE,
        ...(memoryNote ? [memoryNote] : []),
      ],
    })
    await loader.reload()

    // Each persona may pin its own model ("provider/id"); undefined → default.
    const model = resolveModelRef(resolved, allowCloud, persona.model)

    // Auto-compaction: trigger when context exceeds 90K tokens.
    // reserveTokens = contextWindow - threshold. For 128K ctx: 128000 - 90000 = 38000.
    const settings = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: compactionReserveTokens },
    })

    // Disk-backed session when a sessionDir is given: reopen the most recent
    // session file in it (or start one), so the agent's private context —
    // thinking, tool results, compaction — survives restarts and room resume.
    let sessionManager: SessionManager
    if (sessionDir) {
      mkdirSync(sessionDir, { recursive: true })
      sessionManager = SessionManager.continueRecent(workspaceDir, sessionDir)
      p.resumed = sessionManager.buildSessionContext().messages.length > 0
      p.sessionDir = sessionDir
    } else {
      sessionManager = SessionManager.inMemory(workspaceDir)
    }

    const { session } = await createAgentSession({
      cwd: workspaceDir,
      // Disable built-in file tools and supply workspace-confined replacements,
      // gated to this persona's allowlist. Keeps all file work inside the workspace.
      noTools: "builtin",
      customTools: (() => {
        const confined = buildConfinedTools(workspaceDir, persona.tools)
        const custom = buildCustomTools(persona.tools, { orchestrator })
        console.log(`[Participant.create] persona=${persona.id} orchestrator=${!!orchestrator} confined=${confined.length} custom=${custom.length} customNames=${custom.map(t => t.name).join(",")}`)
        return [...confined, ...custom]
      })(),
      thinkingLevel: persona.thinkingLevel ?? defaultThinkingLevel,
      resourceLoader: loader,
      sessionManager,
      settingsManager: settings,
      authStorage: resolved.authStorage,
      modelRegistry: resolved.modelRegistry,
      ...(model ? { model } : {}),
    })
    // Enable auto-compaction on the session (triggers compact() automatically
    // when context tokens exceed the threshold after each turn).
    session.setAutoCompactionEnabled(true)
    // Name the session after the persona for debug visibility.
    session.setSessionName(persona.id)
    p.session = session
    p.unsubscribe = session.subscribe((ev) => p.onEvent(ev))
    return p
  }

  private setStatus(status: ParticipantStatus): void {
    this.status = status
    this.emit("status", { id: this.persona.id, status })
  }

  private onEvent(ev: AgentSessionEvent): void {
    if (ev.type === "message_update") {
      const me = ev.assistantMessageEvent
      if (me.type === "text_delta") {
        this.buffer += me.delta
        this.emit("token", { id: this.persona.id, delta: me.delta })
      } else if (me.type === "thinking_delta") {
        this.reasoningBuffer += me.delta
        this.emit("reasoning", { id: this.persona.id, delta: me.delta })
      }
    } else if (ev.type === "tool_execution_start") {
      const item: ToolActivity = {
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        args: ev.args,
        status: "running",
        ts: Date.now(),
      }
      this.activity.set(ev.toolCallId, item)
      this.setStatus("working")
      this.emit("activity", { id: this.persona.id, item })
    } else if (ev.type === "compaction_start") {
      this.emit("status", { id: this.persona.id, status: "compacting", reason: ev.reason })
    } else if (ev.type === "compaction_end") {
      this.emit("status", { id: this.persona.id, status: "idle", compactionResult: ev.result ? { summary: ev.result.summary.slice(0, 200), tokensBefore: ev.result.tokensBefore } : undefined })
    } else if (ev.type === "tool_execution_end") {
      const item = this.activity.get(ev.toolCallId) ?? {
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        status: "running" as const,
        ts: Date.now(),
      }
      item.status = ev.isError ? "error" : "ok"
      item.result = clip(ev.result)
      this.activity.set(ev.toolCallId, item)
      this.setStatus("active")
      this.emit("activity", { id: this.persona.id, item })
    } else if (ev.type === "auto_retry_start") {
      this.emit("status", {
        id: this.persona.id,
        status: "retrying",
        retry: {
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
          delayMs: ev.delayMs,
          errorMessage: ev.errorMessage,
        },
      })
    } else if (ev.type === "auto_retry_end") {
      this.emit("status", {
        id: this.persona.id,
        status: ev.success ? "active" : "idle",
        retryResult: {
          success: ev.success,
          attempt: ev.attempt,
          finalError: ev.finalError,
        },
      })
    }
  }

  /** Run one turn with the given prompt text. Optionally pass image paths
   *  (workspace-relative, e.g. "media/abc.png") for vision support. */
  async run(promptText: string, imagePaths?: string[]): Promise<TurnResult> {
    this.buffer = ""
    this.reasoningBuffer = ""
    this.activity.clear()
    this.setStatus("active")
    try {
      const images = await this.resolveImages(imagePaths)
      await this.session.prompt(promptText, images.length > 0 ? { images } : undefined)
      const result: TurnResult = {
        text: this.buffer.trim(),
        activity: [...this.activity.values()],
      }
      if (this.reasoningBuffer.trim()) {
        result.reasoning = this.reasoningBuffer.trim()
      }
      // Check if the agent called ask_user — extract the question from the tool args.
      for (const act of result.activity) {
        if (act.toolName === "ask_user" && act.status === "ok") {
          const args = act.args as Record<string, unknown> | undefined
          const q = typeof args?.question === "string" ? args.question : undefined
          if (q) {
            result.question = q
            break
          }
        }
      }
      return result
    } finally {
      this.setStatus("idle")
    }
  }

  /** Resolve workspace-relative image paths to ImageContent objects for the LLM. */
  private async resolveImages(paths?: string[]): Promise<
    Array<{ type: "image"; data: string; mimeType: string }>
  > {
    if (!paths) return []
    const images: Array<{ type: "image"; data: string; mimeType: string }> = []
    for (const relPath of paths) {
      try {
        const fullPath = join(this.workspaceDir, relPath)
        const buf = readFileSync(fullPath)
        const ext = relPath.split(".").pop()?.toLowerCase()
        const mimeType = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg"
        images.push({ type: "image", data: buf.toString("base64"), mimeType })
      } catch (err) {
        // Skip images that fail to read.
        console.warn(`[participant] image read failed: ${relPath} — ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return images
  }

  async abort(): Promise<void> {
    await this.session.abort()
  }

  /** Compact the agent's session context (summarize old turns to free tokens). */
  async compact(): Promise<{ summary: string; tokensBefore: number }> {
    const result = await this.session.compact(this.persona.compactionInstructions)
    return { summary: result.summary, tokensBefore: result.tokensBefore }
  }

  /** Whether the agent is currently compacting. */
  get isCompacting(): boolean {
    return this.session.isCompacting
  }

  /** Get the agent's current context usage. Undefined if the session has no usage info yet. */
  getContextUsage(): ReturnType<AgentSession["getContextUsage"]> {
    return this.session.getContextUsage()
  }

  /** Set thinking level in-place — no session recreation needed. */
  async setThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): Promise<void> {
    await this.session.setThinkingLevel(level)
    this.persona.thinkingLevel = level
  }

  /** Set vision capability in-place — pure metadata, no session recreation. */
  setVision(vision: boolean): void {
    this.persona.vision = vision
  }

  /** Get the thinking levels supported by the current model. */
  getAvailableThinkingLevels(): string[] {
    return this.session.getAvailableThinkingLevels() ?? []
  }

  /** Get session stats — token counts, cache split, turn counts. */
  getSessionStats(): ReturnType<AgentSession["getSessionStats"]> | undefined {
    return this.session.getSessionStats()
  }

  /** Get the last assistant response text (convenience method). */
  getLastAssistantText(): string | undefined {
    return this.session.getLastAssistantText()
  }

  /** Export the agent's session to a self-contained HTML file. Returns the file path. */
  async exportToHtml(): Promise<string> {
    return await this.session.exportToHtml()
  }

  /** Export the agent's session as JSONL (one JSON object per line). Returns the file path. */
  exportToJsonl(): string {
    return this.session.exportToJsonl()
  }

  /** Queue a steering message while the agent is running.
   *  Throws if the session is not currently streaming — can't steer an idle agent. */
  async steer(text: string): Promise<void> {
    if (!this.session.isStreaming) {
      throw new Error(`participant "${this.persona.id}" is not running — cannot steer`)
    }
    await this.session.steer(text)
  }

  /** Queue a follow-up message — guaranteed to be the next thing the agent
   *  processes. Used for self-chaining (e.g., delivering an ask_user answer
   *  directly to the agent that asked it). */
  async followUp(text: string, imagePaths?: string[]): Promise<TurnResult> {
    this.buffer = ""
    this.reasoningBuffer = ""
    this.activity.clear()
    this.setStatus("active")
    try {
      const images = await this.resolveImages(imagePaths)
      // session.followUp() only delivers when the agent is currently streaming.
      // After ask_user (terminate=true) the session is idle — the followUp message
      // would be queued but never processed. Use prompt() for idle sessions instead.
      if (!this.session.isStreaming) {
        await this.session.prompt(text, images.length > 0 ? { images } : undefined)
      } else {
        await this.session.followUp(text, images.length > 0 ? images : undefined)
      }
      const result: TurnResult = {
        text: this.buffer.trim(),
        activity: [...this.activity.values()],
      }
      if (this.reasoningBuffer.trim()) {
        result.reasoning = this.reasoningBuffer.trim()
      }
      // Check for ask_user in the follow-up result too.
      for (const act of result.activity) {
        if (act.toolName === "ask_user" && act.status === "ok") {
          const args = act.args as Record<string, unknown> | undefined
          const q = typeof args?.question === "string" ? args.question : undefined
          if (q) {
            result.question = q
            break
          }
        }
      }
      return result
    } finally {
      this.setStatus("idle")
    }
  }

  /** Inject a custom message into the agent's context (invisible in the transcript).
   *  Used for structured signals like work receipts between agents. */
  async sendCustomMessage(message: {
    customType: string
    content: string
    display: boolean
  }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
    await this.session.sendCustomMessage(message, options)
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.session.dispose()
  }
}
