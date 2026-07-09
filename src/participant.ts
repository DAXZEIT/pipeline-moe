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
import { installBatchTerminateGuard, type BatchTerminateGuard } from "./batch-terminate-guard.js"
import { buildConfinedTools } from "./sandbox-tools.js"
import { buildCustomTools } from "./custom-tools/index.js"
import { resolveModelRef, type ResolvedModel } from "./model.js"
import type { ParentLink, RoomOrchestrator } from "./orchestrator.js"
import type { TaskBoard } from "./task-board.js"
import type { HandoffSink, Persona, ParticipantStatus, ToolActivity } from "./types.js"

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
  "You are one agent in a shared multi-agent chat room. Other agents (e.g. scout, builder, " +
  "auditor, scribe, tester) are referred to by their lowercase id. To pass your turn to another " +
  "agent, call the handoff tool with their id — that is the ONLY way to hand off. Writing " +
  "'@name' or their name in your reply does NOTHING — there is no text-based routing anymore. " +
  "You can freely discuss, quote, or refer to other agents by name in your reply (e.g. 'the " +
  "builder said...', or narrating what @tester did earlier) without triggering anything — only " +
  "the handoff tool call routes. If you don't call handoff, your turn ends and control returns " +
  "to the human — that is a valid, normal ending, not an error.\n" +
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
  /** Closed answer choices offered with the question (ask_user `options`) —
   *  pure display metadata: clients render a picker, but the answer travels
   *  back as an ordinary text message either way. */
  questionOptions?: string[]
  /** Set when the turn did NOT end normally: "aborted" (room/user stopped it
   *  mid-stream) or "error" (provider/model failure — e.g. retries exhausted
   *  on a 5xx). Unset for a normal completion — pi-agent-core's stopReason
   *  can also be "stop"/"length"/"toolUse", which all mean "the model
   *  finished", just via different natural endings; those collapse to this
   *  field being absent. `text`/`activity` above already hold whatever
   *  streamed before the abnormal stop — this field is purely a marker for
   *  callers deciding how to present a partial reply (see F7/knownissues.md). */
  stopReason?: "aborted" | "error"
  /** Present when stopReason is "error" — the underlying failure message. */
  errorMessage?: string
}

/** Element type of AgentSession.messages, without importing the (unexported
 *  from pi-coding-agent's public surface, only from its transitive
 *  pi-agent-core dependency) AgentMessage type by name. */
type SessionMessage = AgentSession["messages"][number]

/** Scan a finished turn's activity for a pausing question — ask_user (answered
 *  by the human) or ask_orchestrator (answered by the parent room's spawner via
 *  answer_room). Both freeze the pipeline identically. Returns the question
 *  plus any closed answer `options` (ask_user only), sanitized: trimmed
 *  non-empty strings, capped at 6 — a model passing garbage degrades to a
 *  plain free-text question, never a broken picker. */
export function extractPauseQuestion(
  activity: ToolActivity[],
): { question: string; options?: string[] } | null {
  for (const act of activity) {
    if ((act.toolName === "ask_user" || act.toolName === "ask_orchestrator") && act.status === "ok") {
      const args = act.args as Record<string, unknown> | undefined
      const q = typeof args?.question === "string" ? args.question : undefined
      if (!q) continue
      const raw = Array.isArray(args?.options) ? args.options : []
      const options = raw
        .filter((o): o is string => typeof o === "string")
        .map((o) => o.trim())
        .filter((o) => o.length > 0)
        .slice(0, 6)
      return options.length > 0 ? { question: q, options } : { question: q }
    }
  }
  return null
}

/** Walk back from the end of the session's message list to the most recent
 *  assistant message and read its stopReason/errorMessage — the authoritative
 *  source (set by the vendored harness itself on abort/provider-failure),
 *  rather than trying to infer abnormal termination from our own streamed
 *  event buffers. Returns undefined for a normal completion. */
function extractAbnormalStop(
  messages: SessionMessage[],
): { stopReason: "aborted" | "error"; errorMessage?: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "assistant") {
      if (m.stopReason === "aborted" || m.stopReason === "error") {
        return { stopReason: m.stopReason, errorMessage: m.errorMessage }
      }
      return undefined
    }
  }
  return undefined
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
  private terminateGuard: BatchTerminateGuard | null = null
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
    /** The room's shared task board. When present, every agent gets the
     *  task_create/task_update/task_list tools. */
    taskBoard?: TaskBoard,
    /** Id of the room this participant lives in — recorded by spawn_room as
     *  the parent of any sub-room it creates. */
    roomId?: string,
    /** Link to the parent room, present only in spawned sub-rooms — grants
     *  the ask_orchestrator escalation tool. */
    parentLink?: ParentLink,
    /** The room's live roster capability for the handoff tool. Present for
     *  every room (Registry implements it); the tool itself is only granted
     *  when at least one other active agent exists to hand off to. */
    handoffSink?: HandoffSink,
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
        const custom = buildCustomTools(persona.tools, { orchestrator, taskBoard, personaId: persona.id, roomId, parentLink, handoffSink })
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
    // Batch-terminate guard: once a turn-control tool (handoff/ask_user/
    // ask_orchestrator) finalizes with terminate: true, force it onto every
    // later tool result of the same run so the batch actually ends the turn
    // (pi-agent-core requires EVERY result in a batch to set it). See
    // batch-terminate-guard.ts for why this can't go through the extension seam.
    p.terminateGuard = installBatchTerminateGuard(session.agent)
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
    this.terminateGuard?.reset()
    this.setStatus("active")
    try {
      const images = await this.resolveImages(imagePaths)
      let thrown: unknown
      try {
        await this.session.prompt(promptText, images.length > 0 ? { images } : undefined)
      } catch (err) {
        // session.prompt() is documented to resolve even on abort/provider-error
        // (tagging the assistant message's stopReason instead of rejecting) —
        // a real throw here is a library-level surprise, not the normal F7
        // failure mode. Still salvage whatever streamed into our own buffers
        // before treating it as an error turn, rather than losing that too.
        thrown = err
      }
      const result: TurnResult = {
        text: this.buffer.trim(),
        activity: [...this.activity.values()],
      }
      if (this.reasoningBuffer.trim()) {
        result.reasoning = this.reasoningBuffer.trim()
      }
      if (thrown !== undefined) {
        result.stopReason = "error"
        result.errorMessage = thrown instanceof Error ? thrown.message : String(thrown)
      } else {
        const abnormal = extractAbnormalStop(this.session.messages)
        if (abnormal) {
          result.stopReason = abnormal.stopReason
          if (abnormal.errorMessage) result.errorMessage = abnormal.errorMessage
        }
      }
      // Check if the agent asked a pausing question. A stopReason-tagged
      // (aborted/error) turn's activity is real (tools DID execute) but its
      // "question" isn't actionable — the turn didn't end the normal way a
      // pause is supposed to, so don't let a partial/interrupted turn open a
      // pause state.
      if (!result.stopReason) {
        const pause = extractPauseQuestion(result.activity)
        if (pause) {
          result.question = pause.question
          if (pause.options) result.questionOptions = pause.options
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
    this.terminateGuard?.reset()
    this.setStatus("active")
    try {
      const images = await this.resolveImages(imagePaths)
      // session.followUp() only delivers when the agent is currently streaming.
      // After ask_user (terminate=true) the session is idle — the followUp message
      // would be queued but never processed. Use prompt() for idle sessions instead.
      let thrown: unknown
      try {
        if (!this.session.isStreaming) {
          await this.session.prompt(text, images.length > 0 ? { images } : undefined)
        } else {
          await this.session.followUp(text, images.length > 0 ? images : undefined)
        }
      } catch (err) {
        // See run() — same rationale: a real throw here is a library-level
        // surprise, not the normal F7 failure mode. Salvage what streamed.
        thrown = err
      }
      const result: TurnResult = {
        text: this.buffer.trim(),
        activity: [...this.activity.values()],
      }
      if (this.reasoningBuffer.trim()) {
        result.reasoning = this.reasoningBuffer.trim()
      }
      if (thrown !== undefined) {
        result.stopReason = "error"
        result.errorMessage = thrown instanceof Error ? thrown.message : String(thrown)
      } else {
        const abnormal = extractAbnormalStop(this.session.messages)
        if (abnormal) {
          result.stopReason = abnormal.stopReason
          if (abnormal.errorMessage) result.errorMessage = abnormal.errorMessage
        }
      }
      // Check for ask_user / ask_orchestrator in the follow-up result too — not
      // actionable on a stopReason-tagged (aborted/error) turn, same as run().
      if (!result.stopReason) {
        const pause = extractPauseQuestion(result.activity)
        if (pause) {
          result.question = pause.question
          if (pause.options) result.questionOptions = pause.options
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
