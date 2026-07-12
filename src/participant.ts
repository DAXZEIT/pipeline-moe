// A Participant is a HAT HANDLE: one persona's identity, status, buffers and
// per-turn logic, borrowing its SEAT's pi session for each turn (fused seats,
// docs/fused-seats.md — "le Seat possède la session, les chapeaux
// l'empruntent"). Session construction and ownership live in SeatRuntime;
// a singleton seat (seat == persona) reproduces the pre-feature behavior
// exactly. The shared room transcript is threaded in by Room.

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { config } from "./config.js"
import { ReasoningBudget, reasoningBudgetFor, exhaustedTrace } from "./reasoning-budget.js"
import { buildHatHeader } from "./seats.js"
import { SeatRuntime, type ThinkingLevel } from "./seat-runtime.js"
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
  /** The seat whose session this hat borrows. A singleton seat (seat id ==
   *  persona id) is the pre-feature behavior. */
  readonly seat: SeatRuntime
  active = true
  /** When true, may run concurrently with adjacent parallel-flagged agents.
   *  Meaningless WITHIN a seat — the seat's turn lock serializes its hats. */
  parallel = false
  status: ParticipantStatus = "idle"

  /** Index of the next room transcript entry this participant has NOT yet
   *  seen. SEAT-level state: the session is one context, so replaying an
   *  entry once per hat would inject it twice — every hat reads/writes the
   *  seat's cursor (docs/fused-seats.md §3, the re-derivation tax). */
  get cursor(): number {
    return this.seat.cursor
  }
  set cursor(value: number) {
    this.seat.cursor = value
  }

  /** True when the seat's pi session was reopened from disk with prior
   *  conversation memory — the caller may then restore a saved cursor instead
   *  of replaying the whole room transcript on top of the restored context. */
  get resumed(): boolean {
    return this.seat.resumed
  }

  /** On-disk pi session directory of the SEAT, when persistence is enabled.
   *  Lifecycle (including deletion on last-hat kick) is owned by the
   *  Registry's seat map — refcounted, never per-hat. */
  get sessionDir(): string | undefined {
    return this.seat.sessionDir
  }

  private get session(): AgentSession {
    return this.seat.session
  }
  private buffer = ""
  /** Tool calls made during the current turn, keyed for start/end matching. */
  private activity = new Map<string, ToolActivity>()

  /** Snapshot of the current turn's tool calls so far — read mid-turn by the
   *  Registry's handoff-gate check (the handoff tool executes before the turn
   *  ends, so the finished-turn activity in RunResult doesn't exist yet). */
  liveActivity(): ToolActivity[] {
    return [...this.activity.values()]
  }
  /** Reasoning accumulated during the current turn. */
  private reasoningBuffer = ""
  /** Per-turn reasoning budget (ROADMAP #9) — null on cloud seats / disabled.
   *  Fresh instance per turn (see promptRounds); the thinking-delta watchdog
   *  consumes into it and aborts the generation on breach. */
  private budget: ReasoningBudget | null = null
  /** Set by abort() — distinguishes a user/room stop from the budget
   *  watchdog's breach-abort, so promptRounds never re-prompts over an Esc. */
  private externallyAborted = false
  /** Posts 🧠 checkpoint traces to the room transcript (HandoffSink capability). */
  private checkpointSink: ((text: string) => void) | null = null
  private readonly emit: Emit
  /** The directory this participant's file tools are confined to. */
  private readonly workspaceDir: string

  private constructor(persona: Persona, seat: SeatRuntime, emit: Emit, workspaceDir: string) {
    this.persona = persona
    this.seat = seat
    this.emit = emit
    this.workspaceDir = workspaceDir
  }

  /** Attach a hat handle to its seat's session. Session construction lives in
   *  SeatRuntime.create (the Registry resolves persona → seat and owns the
   *  seat map); this only wires the hat's event handler and turn-time state.
   *  Synchronous — there is nothing to await anymore. */
  static attach(
    persona: Persona,
    seat: SeatRuntime,
    emit: Emit,
    workspaceDir: string = config.workspaceDir,
    /** For the 🧠 checkpoint traces (postSystemNote capability). */
    handoffSink?: HandoffSink,
  ): Participant {
    const p = new Participant(persona, seat, emit, workspaceDir)
    p.checkpointSink = handoffSink?.postSystemNote ? (text) => handoffSink.postSystemNote!(text) : null
    // The seat fans its single session subscription out to the hat holding
    // the turn — this handler only fires while p wears the seat.
    seat.setHandler(persona.id, (ev) => p.onEvent(ev))
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
        // Budget watchdog: on breach, abort THIS generation — promptRounds
        // injects the checkpoint and re-prompts. (steer() can't do this: it
        // queues for AFTER the assistant message ends, and a reasoning loop
        // never ends its message.) consume() fires true once per grant.
        if (this.budget?.consume(me.delta.length)) {
          void this.session.abort()
        }
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

  /** Drive one turn as budget-checkpointed prompt rounds (ROADMAP #9).
   *  Round 1 is the caller's prompt. If the reasoning watchdog breached (and
   *  aborted) the round, inject the next checkpoint and re-prompt in the same
   *  session — the partial reasoning stays in context, so "continue" resumes
   *  rather than restarts. When even the final grant is spent, end the turn
   *  visibly (⚠ trace; the last round keeps its aborted stopReason). An
   *  abort WITHOUT a breach is external (user Esc, room stop) — return as-is.
   *  Buffers accumulate across rounds: the TurnResult carries all of it. */
  private async promptRounds(first: () => Promise<void>): Promise<unknown> {
    this.budget = reasoningBudgetFor(this.seat.modelRef, config.reasoningBudgetChars, config.reasoningBudgetContinues)
    this.externallyAborted = false
    let call = first
    try {
      for (;;) {
        let thrown: unknown
        try {
          await call()
        } catch (err) {
          // session.prompt() is documented to resolve even on abort/provider-error
          // (tagging the assistant message's stopReason instead of rejecting) —
          // a real throw here is a library-level surprise, not the normal F7
          // failure mode. Still salvage whatever streamed into our own buffers
          // before treating it as an error turn, rather than losing that too.
          thrown = err
        }
        if (thrown !== undefined || !this.budget?.breached || this.externallyAborted) return thrown
        const ck = this.budget.nextCheckpoint(this.persona.id)
        if (!ck) {
          this.checkpointSink?.(exhaustedTrace(this.persona.id))
          return undefined
        }
        this.checkpointSink?.(ck.trace)
        const msg = ck.message
        call = () => this.session.prompt(msg)
      }
    } finally {
      this.budget = null
    }
  }

  /** Prefix the hat header on a fused seat (grilling Q3: the thin per-turn
   *  switch — the hat is part of the turn, atomically). Singleton seats pass
   *  the prompt through untouched: byte-compat with the pre-feature turn. */
  private withHatHeader(promptText: string): string {
    if (!this.seat.fused()) return promptText
    return `${buildHatHeader(this.persona, this.seat.seatId, this.seat.hats)}\n\n${promptText}`
  }

  /** Run one turn with the given prompt text. Optionally pass image paths
   *  (workspace-relative, e.g. "media/abc.png") for vision support. */
  async run(promptText: string, imagePaths?: string[]): Promise<TurnResult> {
    // Borrow the seat: serialize intra-seat, set the current hat (event
    // routing + tool attribution + allowlist gate), apply this hat's
    // thinking level. A singleton seat resolves immediately.
    const release = await this.seat.acquireTurn(this.persona.id, this.persona.thinkingLevel)
    this.buffer = ""
    this.reasoningBuffer = ""
    this.activity.clear()
    this.seat.resetGuard()
    this.setStatus("active")
    try {
      const images = await this.resolveImages(imagePaths)
      const prompt = this.withHatHeader(promptText)
      const thrown = await this.promptRounds(() =>
        this.session.prompt(prompt, images.length > 0 ? { images } : undefined),
      )
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
      release()
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
    this.externallyAborted = true
    await this.session.abort()
  }

  /** Compact the SEAT's session context (summarize old turns to free tokens).
   *  Instructions are the seat's — verbatim for a singleton, the labeled
   *  union for a fused seat, so one hat's "Discard" never throws away another
   *  hat's living state (grilling Q4). */
  async compact(): Promise<{ summary: string; tokensBefore: number }> {
    const result = await this.session.compact(this.seat.compactionInstructions())
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

  /** Set thinking level in-place — no session recreation needed. On a fused
   *  seat the session-level change waits for this hat's next turn
   *  (acquireTurn applies it); mutating it now would hijack another hat's
   *  level mid-flight. */
  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    if (!this.seat.fused()) {
      await this.session.setThinkingLevel(level)
    }
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
    // Mid-stream follow-up into our own running turn keeps the lock the
    // running call already holds (acquiring would deadlock on ourselves);
    // an idle-session follow-up borrows the seat like a normal turn.
    const mine = this.session.isStreaming && this.seat.currentHatId === this.persona.id
    const release = mine ? null : await this.seat.acquireTurn(this.persona.id, this.persona.thinkingLevel)
    this.buffer = ""
    this.reasoningBuffer = ""
    this.activity.clear()
    this.seat.resetGuard()
    this.setStatus("active")
    try {
      const images = await this.resolveImages(imagePaths)
      // session.followUp() only delivers when the agent is currently streaming.
      // After ask_user (terminate=true) the session is idle — the followUp message
      // would be queued but never processed. Use prompt() for idle sessions instead.
      // Budget-checkpointed like run(): a resumed turn can overthink too.
      const prompt = this.withHatHeader(text)
      const thrown = await this.promptRounds(() =>
        !this.session.isStreaming
          ? this.session.prompt(prompt, images.length > 0 ? { images } : undefined)
          : this.session.followUp(text, images.length > 0 ? images : undefined),
      )
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
      release?.()
    }
  }

  /** Inject a custom message into the agent's context (invisible in the transcript).
   *  Used for structured signals like work receipts between agents. On a
   *  fused seat this reaches the SHARED session — the Registry dedups
   *  broadcasts (e.g. roster_update) to one per seat. */
  async sendCustomMessage(message: {
    customType: string
    content: string
    display: boolean
  }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
    await this.session.sendCustomMessage(message, options)
  }

  /** Detach this hat from its seat. The SESSION's lifecycle belongs to the
   *  Registry's seat map (refcounted kick — grilling Q7): the seat survives
   *  while another hat lives on it, and only the registry disposes it. */
  dispose(): void {
    this.seat.removeHandler(this.persona.id)
  }
}
