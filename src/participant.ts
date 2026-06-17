// A Participant wraps one pi AgentSession (one persona) and exposes a simple
// run()/dispose() lifecycle. Its session keeps its own conversation memory
// across turns (stateful). The shared room transcript is threaded in by Room.

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent"
import { config } from "./config.js"
import { buildConfinedTools } from "./sandbox-tools.js"
import { resolveModelRef, type ResolvedModel } from "./model.js"
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

const WORKSPACE_NOTE =
  "Your working directory is the shared workspace. Use workspace-relative paths only " +
  "(e.g. `notes.md`, `src/app.ts`). Never read or write outside it — absolute paths " +
  "pointing elsewhere (like your home directory) are denied."

const ROOM_NOTE =
  "You are one agent in a shared multi-agent chat room. Other agents are addressed by " +
  "@<id> in lowercase (e.g. @scout, @builder, @auditor, @scribe, @tester). To hand work " +
  "to another agent, write @<id> EXPLICITLY in your reply — a plain sentence like " +
  "'over to the builder' does NOT trigger anything. Only @-mention an agent when you " +
  "genuinely need it. Do not @-mention yourself, and do not use @all (that is for the human)."

export type Emit = (event: "token" | "status" | "activity" | "reasoning", data: unknown) => void

/** What a turn produced: the final text plus the tool calls made to get there. */
export interface TurnResult {
  text: string
  activity: ToolActivity[]
}

export class Participant {
  readonly persona: Persona
  active = true
  /** When true, may run concurrently with adjacent parallel-flagged agents. */
  parallel = false
  status: ParticipantStatus = "idle"
  /** Index of the next room transcript entry this participant has NOT yet seen. */
  cursor = 0

  private session!: AgentSession
  private unsubscribe: (() => void) | null = null
  private buffer = ""
  /** Tool calls made during the current turn, keyed for start/end matching. */
  private activity = new Map<string, ToolActivity>()
  private readonly emit: Emit

  private constructor(persona: Persona, emit: Emit) {
    this.persona = persona
    this.emit = emit
  }

  static async create(persona: Persona, resolved: ResolvedModel, emit: Emit): Promise<Participant> {
    const p = new Participant(persona, emit)

    const loader = new DefaultResourceLoader({
      cwd: config.workspaceDir,
      agentDir: getAgentDir(),
      // Append the persona to pi's default prompt so we keep tool-usage guidance.
      appendSystemPromptOverride: (base: string[]) => [
        ...base,
        persona.systemPrompt,
        WORKSPACE_NOTE,
        ROOM_NOTE,
      ],
    })
    await loader.reload()

    // Each persona may pin its own model ("provider/id"); undefined → default.
    const model = resolveModelRef(resolved, persona.model)

    const { session } = await createAgentSession({
      cwd: config.workspaceDir,
      // Disable built-in file tools and supply workspace-confined replacements,
      // gated to this persona's allowlist. Keeps all file work inside the workspace.
      noTools: "builtin",
      customTools: buildConfinedTools(config.workspaceDir, persona.tools),
      thinkingLevel: config.thinkingLevel,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(config.workspaceDir),
      authStorage: resolved.authStorage,
      modelRegistry: resolved.modelRegistry,
      ...(model ? { model } : {}),
    })
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
        // Reasoning is streamed live for the activity panel but not persisted.
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
    }
  }

  /** Run one turn with the given prompt text. Returns the reply and tool calls. */
  async run(promptText: string): Promise<TurnResult> {
    this.buffer = ""
    this.activity.clear()
    this.setStatus("active")
    try {
      await this.session.prompt(promptText)
      return { text: this.buffer.trim(), activity: [...this.activity.values()] }
    } finally {
      this.setStatus("idle")
    }
  }

  async abort(): Promise<void> {
    await this.session.abort()
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.session.dispose()
  }
}
