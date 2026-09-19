// The Room: shared transcript + serial turn queue + @mention routing + work
// receipts. One room per process. All model work is serialised here, which
// also matches llama-server running with --parallel 1.

import {
  type ExecFileOptionsWithStringEncoding,
  execFile,
} from "node:child_process"
import { estimateTokens } from "@earendil-works/pi-coding-agent"
import { config } from "../config.js"
import type { LocalModelLock } from "../local-model-lock.js"
import type { Participant } from "../participant.js"
import { planAdoptionId } from "../plan-routing.js"
import {
  diffSnapshots,
  listWorkspace,
  receiptFromActivity,
  receiptHasChanges,
  snapshot,
} from "../receipts.js"
import type { Registry } from "../registry.js"
import type { SseEventName, SseHub } from "../sse.js"
import type { ConversationStore } from "../store.js"
import { TaskBoard } from "../task-board.js"
import { appendBodyMarker } from "../turn-parts.js"
import type {
  Conversation,
  Persona,
  RoomTask,
  RoutingMode,
  ToolActivity,
  TranscriptEntry,
  TurnPart,
  WorkReceipt,
} from "../types.js"

/** Produce a compact one-line summary of a work receipt for injection into the next agent's context. */
function formatReceipt(r: WorkReceipt): string {
  const parts: string[] = []
  if (r.created.length > 0) parts.push(`created: ${r.created.join(", ")}`)
  if (r.modified.length > 0) parts.push(`modified: ${r.modified.join(", ")}`)
  if (r.deleted.length > 0) parts.push(`deleted: ${r.deleted.join(", ")}`)
  return `📋 Work receipt from @${r.participantId}: ${parts.join("; ")}`
}

/** State when the pipeline is paused waiting for a user response to an ask_user. */
export interface PendingQuestion {
  askerId: string
  heldQueue: Participant[]
}

/** A proposed handoff awaiting human approval (semi/manual routing). */
export interface RouteProposal {
  fromId: string
  target: Participant
}

/** State when routing is paused for human approval (semi/manual mode). The
 *  heldQueue is work already queued before the proposal; it resumes once the
 *  human approves / redirects / drops. */
export interface PendingRoute {
  proposals: RouteProposal[]
  heldQueue: Participant[]
}

const MENTION_RE = /@(\w+)/g

/** What one agent produced in a turn, before it is posted to the transcript. */
export interface RunOutput {
  target: Participant
  reply: string
  activity: ToolActivity[]
  reasoning?: string
  /** The turn in chronological order (docs/interleaved-turns.md). */
  parts?: TurnPart[]
  receipt: WorkReceipt
  /** If the agent called ask_user, the question text. */
  question?: string
  /** Closed answer choices offered with the question (display metadata). */
  questionOptions?: string[]
  /** Set when the turn was aborted or failed (provider error) instead of
   *  ending normally — see TurnResult.stopReason. Callers use this to post
   *  the (real, partial) reply with an explicit marker instead of silently
   *  dropping it, while skipping chaining/pause behavior a normal turn would
   *  otherwise get (see knownissues.md F7). */
  stopReason?: "aborted" | "error"
  errorMessage?: string
  /** Wall-clock ms the agent was active (excludes local-lock wait). */
  durationMs: number
}

export function newConvId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Body text for a posted agent turn. An ask_user/ask_orchestrator-only turn
 *  has no prose by design — the question callout IS the body, so don't bake a
 *  "(no response)" placeholder into the transcript above it. A turn that ran
 *  tools but wrote no text says so explicitly: "(no response)" misled the
 *  OTHER agents reading the transcript (observed live 2026-07-09: scribe read
 *  a batched tool-only turn as "the builder didn't respond" and derailed for
 *  two turns arguing about it). Only a turn with nothing at all keeps the
 *  bare placeholder (including interrupted/failed turns: executeAgent nulls
 *  their question, and the partial marker reads naturally after either). */
function turnBody(
  reply: string,
  question: string | undefined,
  activity: ToolActivity[] | undefined,
): string {
  if (reply) return reply
  if (question) return ""
  return activity && activity.length > 0
    ? "(tool calls only — no text reply)"
    : "(no response)"
}

export abstract class RoomCore {
  protected transcript: TranscriptEntry[] = []
  protected chain: Promise<void> = Promise.resolve()
  /** Agents currently mid-turn. >1 when a parallel wave is running. */
  protected running = new Set<Participant>()
  /** Id of the agent currently mid-turn (last started). Kept in sync by
   *  executeAgent so the client's status bar follows chained drains instead
   *  of showing the turn's first agent forever. Used for UI targeting (steer). */
  protected runningAgentId: string | null = null

  /** Fired once when a running goal reaches a terminal status. Set by the
   *  orchestrator on spawned sub-rooms to report back into the parent room —
   *  this is what closes the spawn_room loop without the spawner polling. */
  onGoalResolved:
    | ((status: "completed" | "failed" | "cancelled") => void)
    | null = null

  /** Pending agents to run in the current routing pass. Mutated as agents chain. */
  protected queue: Participant[] = []
  protected aborted = false
  /** Routing mode. 'auto' chains @mentions directly (today's default); 'semi'
   *  pauses each proposed handoff for human approval; 'manual' honors no
   *  agent→agent chaining; 'supervised' submits each proposed handoff to the
   *  supervisor agent for decision. The legacy `chaining` boolean is derived
   *  from this (auto/semi/supervised → on, manual → off) so existing settings,
   *  persistence, and tests keep working unchanged. */
  protected routingMode: RoutingMode = "auto"
  protected get chaining(): boolean {
    return this.routingMode !== "manual"
  }
  protected set chaining(value: boolean) {
    this.routingMode = value ? "auto" : "manual"
  }
  protected chainBudget = 0
  /** Set when an agent called ask_user — pipeline is paused until user responds. */
  protected pendingQuestion: PendingQuestion | null = null
  /** Set in semi/manual mode when proposed handoffs await human approval.
   *  Reused in supervised mode with the supervisor agent as approver. */
  protected pendingRoute: PendingRoute | null = null
  /** Cancel handle for an in-flight supervised decision (the ephemeral
   *  route-supervisor session). Pulled by abortCurrent(): the session is not
   *  a Participant, so the running-set abort sweep never reaches it. */
  protected supervisorAbort: (() => void) | null = null
  /** Anti-ping-pong cap memory: "from→target" pairs the supervisor refused
   *  this turn. A re-proposition of a refused pair escapes to the fallback
   *  agent (or drops) instead of another review round. Cleared at turn start
   *  and endTurn — refusals only bind within the turn they happened in. */
  protected refusedRoutes = new Set<string>()
  /** Agent that handles messages with no @mention. null = first active. */
  protected defaultAgentId: string | null = null
  /** Agent that receives routing fallback when no agent is @-mentioned in a reply. null = disabled. */
  protected fallbackAgentId: string | null = "planner"
  /** When true, no-mention routing consults the active plan (`.pi/plans/`) first:
   *  if the next incomplete step has an `[agent]` owner prefix, route there
   *  instead of the generic fallback agent. Falls through to fallbackAgentId
   *  when there's no active plan, no owner prefix, or the owner is unavailable. */
  protected planAwareRoutingEnabled = true
  /** Goal prompt if this room was started with a goal; null for interactive rooms. */
  protected goalText: string | null = null
  /** Lifecycle status for goal-driven rooms. */
  protected goalStatus:
    | "idle"
    | "running"
    | "completed"
    | "failed"
    | "cancelled" = "idle"
  /** Set by abortCurrent() while a goal is running. Sticky for the whole goal
   *  run — NOT reset per eval iteration — so the goal-eval loop (which clears
   *  `aborted` on every pass) still terminates as "cancelled" instead of spinning
   *  to the next iteration. Cleared by submitGoal() for the next goal. */
  protected goalCancelled = false
  /** Goal completion mode. "auto": complete when the pipeline drains naturally.
   *  "eval": after each drain, route to the evaluator to verify the goal and
   *  either dispatch more work or declare GOAL_MET. */
  protected goalMode: "auto" | "eval" = "auto"
  /** Fallback agent saved while an eval-mode goal suppresses fallback routing.
   *  Restored when the eval loop terminates. */
  protected goalEvalSavedFallback: string | null = null
  /** Plan-aware routing flag saved while an eval-mode goal suppresses it — same
   *  reason as goalEvalSavedFallback: the evaluator is invoked deliberately by
   *  the eval loop, so any other automatic no-mention routing would double up. */
  protected goalEvalSavedPlanAwareRouting: boolean | null = null
  /** The plan THIS conversation has adopted — the ONLY plan plan-aware routing
   *  will consult (bare id). Set when an agent in this room mutates a plan
   *  (planAdoptionId), null until then. Deliberately in-memory and reset on a
   *  new goal / conversation load: a room that hasn't actively worked a plan
   *  routes by no plan, so a stale plan in the shared .pi/plans graveyard can
   *  never hijack a turn (the planner↔tester incident, 2026-07-09). */
  protected activePlanId: string | null = null

  protected saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    protected readonly registry: Registry,
    protected readonly hub: SseHub,
    protected readonly store: ConversationStore,
    protected readonly seedPersonas: Persona[],
    /** Logical room identifier — included in all SSE broadcasts for future room-scoped filtering. */
    readonly roomId: string = "default",
    /** Optional process-global lock for serializing local-model inference across rooms. */
    protected readonly localLock?: LocalModelLock,
    /** Directory this room is scoped to: where file tools are confined, bash runs,
     *  work receipts snapshot, and the workspace listing looks. Defaults to the
     *  pipeline workspace. */
    protected readonly workspaceDir: string = config.workspaceDir,
    /** True when the workspace is a remote (sshfs) mount. Walking the whole
     *  remote tree per turn would stall every action for ~a minute over the
     *  network, so work receipts and the live workspace listing are skipped
     *  for remote rooms. */
    protected readonly remote: boolean = false,
    /** Shared task board. RoomManager passes the SAME instance to the Registry
     *  so the task_* tools mutate the board this room persists/broadcasts.
     *  Defaults to a private board (tests, direct construction). */
    protected readonly taskBoard: TaskBoard = new TaskBoard(),
  ) {
    this.taskBoard.onChange = () => {
      this.broadcastTasks()
      this.scheduleSave()
    }
    // Tell the registry which seat evaluates goals BEFORE participants are
    // built (loadPreset/reset run after construction), so the goal_verdict
    // tool lands on the evaluator's schema. Defensive ?. for test doubles.
    // NB: literal "planner", NOT this.goalEvaluator — that field lives in the
    // RoomGoals subclass and is not initialized while the superclass
    // constructor runs (same value as the field's initializer).
    this.registry.setGoalEvaluator?.("planner")
  }

  /** Broadcast wrapper: tags object payloads with roomId; arrays pass through unmodified. */
  protected emit(event: SseEventName, data: unknown): void {
    const payload =
      data !== null && typeof data === "object" && !Array.isArray(data)
        ? { roomId: this.roomId, ...(data as Record<string, unknown>) }
        : data
    this.hub.broadcast(event, payload, this.roomId)
  }

  getTranscript(): TranscriptEntry[] {
    return this.transcript
  }

  /** The directory this room's agents are scoped to (file tools, bash cwd, receipts). */
  getWorkspaceDir(): string {
    return this.workspaceDir
  }

  /** Workspace file listing for the UI panel. Empty for remote (sshfs) rooms:
   *  walking the whole remote tree over the network would take ~a minute. */
  async getWorkspaceListing(): Promise<Array<{ path: string; size: number }>> {
    return this.remote ? [] : listWorkspace(this.workspaceDir)
  }

  protected async emitWorkspace(): Promise<void> {
    this.emit("workspace", await this.getWorkspaceListing())
  }

  /** Number of participants (active + inactive) in this room's registry. */
  rosterLength(): number {
    return this.registry.roster().length
  }

  /** Expose the registry for server-side route handlers. */
  getRegistry(): Registry {
    return this.registry
  }

  /** Tokens of the SHARED room transcript — the GROUP context, counted once,
   *  independent of any session. NOT the sum of per-seat personal contexts:
   *  each seat's session carries its own copy of the conversation, so summing
   *  seats counts the shared log once per seat (dax, 2026-07-13: "une addition
   *  de chaque contexte n'a aucun but"). Measured with pi's OWN `estimateTokens`
   *  (the same char/4 estimate that drives `shouldCompact`), so this number is
   *  consistent with the eventual room-compaction threshold. Role-agnostic:
   *  estimateTokens is chars/4 for every role, so wrapping each entry's textual
   *  content as a user message gives the same count its true role would. Images
   *  are passed as image blocks so estimateTokens weighs each at pi's own
   *  ESTIMATED_IMAGE_CHARS (~1200 tokens) — the same weight `shouldCompact`
   *  uses; text-only wrapping would silently undercount a transcript that
   *  carries screenshots (auditor, 2026-07-13).
   *
   *  Cost gate (plan asked to measure before shipping a full rescan): direct
   *  recompute benchmarked at 0.6 ms / 2000 entries, 1.2 ms / 10000 entries —
   *  a 30-hop chain's worth of broadcasts is 18–37 ms total, negligible against
   *  seconds-per-hop inference. So NO incremental accumulator: caching a total
   *  maintained from N transcript-write sites (post/startFresh/applyConversation/
   *  load) would trade this project's recurring N-seam divergence risk for a
   *  ~1 ms saving. Direct calc, measured, is the honest choice. */
  protected roomTranscriptTokens(): number {
    let total = 0
    for (const e of this.transcript) {
      let text = e.text ?? ""
      if (e.reasoning) text += e.reasoning
      if (e.activity)
        for (const a of e.activity)
          text += a.toolName + JSON.stringify(a.args ?? {})
      if (e.question) text += e.question
      const imageCount = e.images?.length ?? 0
      if (text.length === 0 && imageCount === 0) continue
      const content: Array<{ type: "text"; text: string } | { type: "image" }> =
        []
      if (text.length > 0) content.push({ type: "text", text })
      for (let i = 0; i < imageCount; i++) content.push({ type: "image" })
      total += estimateTokens({ role: "user", content } as never)
    }
    return total
  }

  /** Room-level GROUP context: tokens of the shared transcript, counted once.
   *  `hotPercent` stays null in v1 — the transcript has no window of its own; a
   *  percent only becomes meaningful once room compaction defines the threshold.
   *  Deliberately does NOT move on `/compact @agent`: compacting a seat's
   *  personal session leaves the shared transcript unchanged (dax, 2026-07-13).
   *  Null (dormant) when the transcript is empty. */
  getRoomUsage(): { tokens: number; hotPercent: number | null } | null {
    const tokens = this.roomTranscriptTokens()
    return tokens > 0 ? { tokens, hotPercent: null } : null
  }

  /** Persist the current conversation and push the refreshed list to clients. */
  async saveCurrent(): Promise<void> {
    if (this.sealed) return
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    // A save must never crash the server. The store fix removed the concurrent
    // rename RACE, but a genuine write failure (ENOSPC, EACCES, a yanked dir)
    // still rejects — and 14 call sites invoke this as `void saveCurrent()`,
    // where a rejection becomes an unhandled rejection and takes the process
    // down (Node 26). Swallow-and-log: a lost snapshot is bad, a dead server is
    // worse, and a SILENT lost snapshot is the exact failure class this whole
    // lot was about — so it's logged and surfaced as a notice, never silent.
    try {
      await this.store.write(this.buildConversation())
      await this.broadcastConversations()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[room] saveCurrent failed: ${msg}`)
      this.notice(
        `save failed — this snapshot was not persisted: ${msg}`,
        "error",
      )
    }
  }

  /** True once the shutdown flush has run — no save may fire past it. The
   *  teardown itself mutates the roster (disposeAll clears every participant,
   *  firing onChange → scheduleSave), so an unsealed room would clobber the
   *  flushed snapshot with the demolition state. Observed live (2026-07-11,
   *  first implementation of this flush): snapshot persisted with
   *  `personas: []` — seeds included — because the flush ran after disposal. */
  protected sealed = false

  /** Flush persistence before shutdown, then seal: fire a pending debounced
   *  save now, wait out the store's write chain, and refuse every later save.
   *  Without the flush, up to 400 ms of mutations (a scheduleSave in flight)
   *  or an in-progress snapshot die with the process; without the seal, the
   *  teardown overwrites what was just flushed. */
  async flushWrites(): Promise<void> {
    if (this.saveTimer) await this.saveCurrent()
    await this.store.flush()
    this.sealed = true
  }

  /** Debounced autosave, for bursty roster mutations. */
  protected scheduleSave(): void {
    if (this.sealed) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.saveCurrent()
    }, 400)
  }

  getTasks(): RoomTask[] {
    return this.taskBoard.list()
  }

  protected broadcastTasks(): void {
    this.emit("tasks", { tasks: this.taskBoard.list() })
  }

  /** True while an agent is running or queued — editing a roster member's
   *  session (which disposes+recreates it) is unsafe during this window. */
  isBusy(): boolean {
    return (
      this.running.size > 0 ||
      this.queue.length > 0 ||
      this.pendingQuestion !== null ||
      this.pendingRoute !== null
    )
  }

  /** True only while agents are actively generating or queued to generate.
   *  Unlike isBusy(), a pause (ask_user / routing approval) does NOT count:
   *  the room is quiescent then, and compacting an agent session during that
   *  window is safe — it's precisely when you'd want to free context. Guard
   *  for the compact endpoints only; every other mutation keeps strict isBusy()
   *  because a pause still holds a frozen queue. */
  isGenerating(): boolean {
    return this.running.size > 0 || this.queue.length > 0
  }

  protected ensureIdle(): void {
    if (
      this.running.size > 0 ||
      this.queue.length > 0 ||
      this.pendingQuestion !== null ||
      this.pendingRoute !== null
    ) {
      throw new Error(
        "a turn is running — press Stop before switching discussions",
      )
    }
  }

  protected post(
    author: string,
    authorName: string,
    text: string,
    activity?: ToolActivity[],
    reasoning?: string,
    images?: string[],
    question?: string,
    questionOptions?: string[],
    durationMs?: number,
    handoffTo?: string,
    parts?: TurnPart[],
  ): TranscriptEntry {
    const entry: TranscriptEntry = {
      index: this.transcript.length,
      author,
      authorName,
      text,
      ts: Date.now(),
      ...(activity && activity.length > 0 ? { activity } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(images && images.length > 0 ? { images } : {}),
      ...(question ? { question } : {}),
      ...(question && questionOptions && questionOptions.length > 0
        ? { questionOptions }
        : {}),
      ...(durationMs != null ? { durationMs } : {}),
      ...(handoffTo ? { handoffTo } : {}),
      ...(parts && parts.length > 0 ? { parts } : {}),
    }
    this.transcript.push(entry)

    this.emit("message", entry)
    return entry
  }

  protected notice(msg: string, level: "info" | "error" = "info"): void {
    this.emit("notice", { msg, level })
  }

  /** End the current turn — clears runningAgentId and broadcasts turn end. */
  protected async endTurn(): Promise<void> {
    this.runningAgentId = null
    // Refusal cap memory is per-turn — a refuse must survive the proposer's
    // re-run (which happens within the turn) but not leak into the next one.
    this.refusedRoutes.clear()
    // Natural turn completion: if a goal was running, resolve it.
    if (this.goalText !== null && this.goalStatus === "running") {
      if (this.goalMode === "eval") {
        // Don't auto-complete — hand off to the evaluator to verify the goal
        // and drive the dispatch loop. runGoalEval sets the terminal status.
        await this.runGoalEval()
      } else {
        this.resolveGoal("completed")
      }
    }
    this.emit("turn", { phase: "end" })
    await this.emitWorkspace()
  }

  /** Truncate the shared transcript to its first `keep` entries. Agents whose
   *  cursor had advanced past the cut have the removed messages inside their
   *  private pi session — those sessions are rebuilt from scratch (they replay
   *  the kept transcript on their next turn). Agents still behind the cut are
   *  untouched. */
  async rollbackTo(keep: number): Promise<number> {
    this.ensureIdle()
    if (!Number.isInteger(keep) || keep < 0 || keep >= this.transcript.length) {
      throw new Error(
        `nothing to roll back (transcript has ${this.transcript.length} entries)`,
      )
    }
    const removed = this.transcript.length - keep
    this.transcript = this.transcript.slice(0, keep)
    await this.registry.rollbackSessions(keep)
    this.emit("transcript", this.transcript)
    await this.saveCurrent()
    this.notice(
      `Rolled back ${removed} message${removed === 1 ? "" : "s"}.`,
      "info",
    )
    return removed
  }

  /** Run a user shell command in the room's workspace and post `$ cmd` + its
   *  output to the shared transcript (author "shell") — Claude Code's `!`
   *  mode, but the result becomes context every agent sees on its next turn.
   *  No routing, no agent turn. Output is clipped so one
   *  `cat` of a huge file can't blow up the transcript. */
  async runShell(command: string): Promise<TranscriptEntry> {
    const output = await new Promise<{
      text: string
      code: number | string | null
    }>((done) => {
      execFile(
        "bash",
        ["-c", command],
        // detached → new session, NO controlling terminal: sudo/ssh password
        // prompts fail fast with "a terminal is required" instead of hijacking
        // the server console and hanging until the timeout. Interactive
        // commands belong to the TUI's client-side runner. (`detached` is a
        // spawn option execFile forwards at runtime; its typings omit it.)
        {
          cwd: this.workspaceDir,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          detached: true,
          encoding: "utf8",
        } as ExecFileOptionsWithStringEncoding,
        (err: Error | null, stdout: string, stderr: string) => {
          const merged = [stdout, stderr].filter((s) => s.length > 0).join("")
          const e = err as
            | (NodeJS.ErrnoException & {
                code?: number | string
                killed?: boolean
              })
            | null
          const code = e ? (e.killed ? "timeout" : (e.code ?? 1)) : 0
          done({ text: merged || (e && !merged ? e.message : ""), code })
        },
      )
    })
    return this.postShellRecord(command, output.text, output.code)
  }

  /** Post an already-executed shell command + output to the shared transcript
   *  (author "shell"). Used by runShell above, and directly by clients that ran
   *  the command interactively in their own terminal (TUI `!` mode) — the
   *  execution was local, the context is shared. */
  postShellRecord(
    command: string,
    output: string,
    exitCode: number | string | null,
  ): TranscriptEntry {
    const max = 8000
    const clipped =
      output.length > max
        ? `${output.slice(0, max)}\n… (+${output.length - max} chars)`
        : output
    // 130/143 = 128+SIGINT/SIGTERM: the user stopped the command (Ctrl+C on a
    // ping, say). Label it as deliberate — "(exit 130)" reads as a failure and
    // sends agents chasing an error that never happened.
    const interrupted =
      exitCode === 130 ||
      exitCode === 143 ||
      exitCode === "SIGINT" ||
      exitCode === "SIGTERM"
    const suffix = interrupted
      ? "\n(stopped by user — partial output, not an error)"
      : exitCode === "timeout"
        ? "\n(timed out after 30s — partial output)"
        : exitCode !== 0 && exitCode !== null
          ? `\n(exit ${exitCode})`
          : ""
    const text = `$ ${command}\n${clipped.trimEnd() || "(no output)"}${suffix}`
    const entry = this.post("shell", "Shell", text)
    void this.saveCurrent()
    return entry
  }

  /** Steer a running agent mid-turn. Posts a (steered) notice to the transcript
   *  for visibility, then queues the message via the agent's session. */
  async steer(targetId: string, text: string): Promise<void> {
    const p = this.registry.get(targetId)
    if (!p) throw new Error(`unknown participant "${targetId}"`)
    // Post a visible record to the transcript.
    this.post("user", "You", `↳ steered @${targetId}: ${text}`)
    await p.steer(text)
  }

  /** Parse @mentions and resolve to the ordered list of participants to run. */
  protected resolveTargets(text: string): Participant[] {
    const mentioned = new Set<string>()
    let m: RegExpExecArray | null = MENTION_RE.exec(text)
    while (m !== null) {
      mentioned.add(m[1].toLowerCase())
      m = MENTION_RE.exec(text)
    }

    // @all (human-only) fans out to everyone, even alongside other mentions.
    if (mentioned.has("all")) {
      return this.registry.activeParticipants()
    }

    // No mention → the default agent (or the first active one as fallback).
    if (mentioned.size === 0) {
      const active = this.registry.activeParticipants()
      if (active.length === 0) return []
      const preferred = this.defaultAgentId
        ? active.find((p) => p.persona.id === this.defaultAgentId)
        : undefined
      return [preferred ?? active[0]]
    }

    const targets: Participant[] = []
    for (const id of mentioned) {
      const p = this.registry.get(id)
      if (!p) {
        this.notice(`No participant "@${id}" in the room.`, "error")
        continue
      }
      if (!p.active) {
        this.notice(`@${id} is deactivated — skipping.`, "info")
        continue
      }
      targets.push(p)
    }
    return targets
  }

  /** Resolve the handoff target registered BY an agent via the `handoff`
   *  tool during its turn (replaces the old @mention text-scan — see F5:
   *  prose "@name" in a reply couldn't be told apart from a quote or
   *  description of someone else's handoff). Consumes (clears) the
   *  registration so it is used exactly once. Defensively re-checks active +
   *  not-self even though the tool already validates at execution time —
   *  the roster can change between the tool call and this read. */
  protected resolveHandoff(selfId: string): Participant[] {
    const to = this.registry.takeHandoff(selfId)
    if (!to || to === selfId) return []
    const p = this.registry.get(to)
    if (!p?.active) return []
    return [p]
  }

  /** Build the prompt for a participant: the room lines it hasn't seen yet
   *  (excluding its own past messages, which live in its session memory).
   *  Also collects images from the last user message for vision support. */
  protected buildContext(p: Participant): { text: string; images?: string[] } {
    const unseen = this.transcript
      .slice(p.cursor)
      .filter((e) => e.author !== p.persona.id)
    const lines = unseen.map((e) => `${e.authorName}: ${e.text}`).join("\n\n")

    // Collect images from the last user message in the unseen range.
    // These are the images the user attached to their most recent message.
    // A local model with no mmproj loaded refuses the request outright if an
    // image reaches it, so an agent without vision never gets one attached —
    // regardless of whether it was the mentioned target or reached the image
    // later via chaining.
    const userEntry = [...unseen].reverse().find((e) => e.author === "user")
    const canSeeImages = p.persona.vision !== false
    const images = canSeeImages ? userEntry?.images : undefined
    const omittedNote =
      !canSeeImages && userEntry?.images?.length
        ? `\n\n(${userEntry.images.length} image${userEntry.images.length === 1 ? "" : "s"} attached to that message — you don't have vision enabled and can't see them.)`
        : ""

    return {
      text: `${lines}\n\n---\nYou are ${p.persona.name}. Respond to the conversation above from your perspective now.${omittedNote}`,
      images,
    }
  }

  /** Announce the execution order when a frozen queue resumes. The order is
   *  otherwise invisible and reads as a routing bug (observed 2026-07-08: a
   *  held @scribe legitimately ran before a freshly mentioned @builder). */
  protected noticeQueueOrder(heldIds: Set<string>): void {
    if (this.queue.length === 0) return
    const order = this.queue
      .map(
        (p) => `@${p.persona.id}${heldIds.has(p.persona.id) ? " (held)" : ""}`,
      )
      .join(", then ")
    this.notice(`Resuming: ${order}`)
  }

  /** Deliver an orchestrator-level message (sub-room goal report or
   *  ask_orchestrator question) into this room, routed to `targetAgentId`.
   *  Serialized on the turn chain, so a busy room finishes its current turn
   *  first. If the room is paused (ask_user) or awaiting a routing approval,
   *  the message is posted passively — hijacking a frozen queue would corrupt
   *  the pause — and the target reads it on its next turn. */
  injectOrchestratorReport(text: string, targetAgentId: string): void {
    this.chain = this.chain
      .then(() => this.processOrchestratorReport(text, targetAgentId))
      .catch((err) => {
        this.notice(
          `Room error: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        )
      })
  }

  protected async processOrchestratorReport(
    text: string,
    targetAgentId: string,
  ): Promise<void> {
    this.post("orchestrator", "Orchestrator", text)
    if (this.pendingQuestion || this.pendingRoute) {
      this.notice(
        `Sub-room report delivered — @${targetAgentId} will see it after the current pause.`,
        "info",
      )
      await this.saveCurrent()
      return
    }
    const target = this.registry.get(targetAgentId)
    if (!target?.active) {
      this.notice(
        `Sub-room report posted, but @${targetAgentId} is not available to act on it.`,
        "info",
      )
      await this.saveCurrent()
      return
    }
    this.queue = [target]
    this.aborted = false
    this.chainBudget = 0
    this.runningAgentId = target.persona.id
    this.emit("turn", {
      phase: "start",
      targets: [targetAgentId],
      agentId: targetAgentId,
    })
    const paused = await this.drainQueue()
    if (paused) {
      await this.emitWorkspace()
      await this.saveCurrent()
      return
    }
    this.queue = []
    await this.endTurn()
    await this.saveCurrent()
  }

  /** Public entry point. Enqueues the message; processing streams over SSE. */
  submit(text: string, images?: string[]): void {
    this.chain = this.chain
      .then(() => this.process(text, images))
      .catch((err) => {
        this.notice(
          `Room error: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        )
      })
  }

  protected async process(text: string, images?: string[]): Promise<void> {
    const trimmed = text.trim()
    this.chainBudget = 0 // reset chain budget for this turn
    // Defensive: an aborted turn never reaches endTurn, so stale refusals
    // could otherwise cap a legitimate proposal in the NEXT turn.
    this.refusedRoutes.clear()

    // Handle /cancel while paused — cancel the question and drain the held queue.
    if (this.pendingQuestion && trimmed === "/cancel") {
      const held = this.pendingQuestion.heldQueue
      this.pendingQuestion = null
      this.post("user", "You", trimmed)
      this.notice("Question cancelled. Resuming pipeline.")
      this.queue = held
      this.noticeQueueOrder(new Set(held.map((p) => p.persona.id)))
      this.aborted = false
      const paused = await this.drainQueue()
      if (paused) {
        await this.emitWorkspace()
        await this.saveCurrent()
        return
      }
      this.queue = []
      await this.endTurn()
      await this.saveCurrent()
      return
    }

    if (await this.handleSlashCommand(trimmed)) return

    // ── Resume from paused state ──────────────────────────────────────────
    if (this.pendingQuestion) {
      const pq = this.pendingQuestion
      this.pendingQuestion = null
      // Snapshot before proposeChain mutates heldQueue — lets the resume
      // notice distinguish held work from freshly mentioned agents.
      const heldIds = new Set(pq.heldQueue.map((p) => p.persona.id))

      this.post("user", "You", trimmed, undefined, undefined, images)
      this.emit("turn", { phase: "resume", askerId: pq.askerId })
      this.aborted = false

      // Force-route to the agent that asked the question.
      const asker = this.registry.get(pq.askerId)
      if (!asker?.active) {
        this.notice(
          `@${pq.askerId} is no longer active — resuming held queue.`,
          "info",
        )
        this.queue = pq.heldQueue
        this.noticeQueueOrder(heldIds)
        const paused = await this.drainQueue()
        if (paused) {
          await this.emitWorkspace()
          await this.saveCurrent()
          return
        }
        this.queue = []
        await this.endTurn()
        await this.saveCurrent()
        return
      }

      // Use followUp() instead of runAgent() — the user's answer is delivered
      // directly to the agent that asked the question. The agent already has the
      // conversation context in its session memory; followUp() guarantees it's
      // the next thing the agent processes.
      const result = await this.followUpAgent(asker, { text: trimmed, images })
      if (result) {
        // F7: previously gated on `!this.aborted`, discarding the asker's real
        // reply (and its receipt) whenever the room had been stopped. Post it
        // regardless, tagged if interrupted/failed — only the re-pause and
        // chaining below are skipped for a non-normal ending.
        const interrupted = !!result.stopReason
        const marker =
          result.stopReason === "aborted"
            ? " _(interrupted — partial)_"
            : result.stopReason === "error"
              ? ` _(failed — partial${result.errorMessage ? `: ${result.errorMessage}` : ""})_`
              : ""
        // Post with question field if the asker asked another question.
        // Same handoff stamping + stale-registration hygiene as the drain loop.
        let resumeHandoffTo = this.registry.peekHandoff?.(asker.persona.id)
        if (resumeHandoffTo && (interrupted || !this.chaining)) {
          this.registry.takeHandoff(asker.persona.id)
          resumeHandoffTo = undefined
        }
        this.post(
          asker.persona.id,
          asker.persona.name,
          turnBody(result.reply, result.question, result.activity) + marker,
          result.activity,
          result.reasoning,
          undefined,
          result.question,
          result.questionOptions,
          undefined,
          resumeHandoffTo,
          appendBodyMarker(result.parts, marker),
        )
        if (receiptHasChanges(result.receipt))
          this.emit("receipt", result.receipt)
        asker.cursor = this.transcript.length

        // If the asker asked ANOTHER question, re-pause. Not for an
        // interrupted/failed reply — its "question" (if any) isn't a real
        // pause request (executeAgent already nulls it, checked again here
        // for a locally-obvious invariant rather than trusting a call away).
        if (result.question && !interrupted) {
          this.pendingQuestion = {
            askerId: asker.persona.id,
            heldQueue: pq.heldQueue,
          }
          this.emit("turn", {
            phase: "pause",
            askerId: asker.persona.id,
            question: result.question,
            options: result.questionOptions,
          })
          await this.emitWorkspace()
          await this.saveCurrent()
          return
        }

        // Chain from the asker's reply onto the held queue (it resumes draining
        // below). Routes identically to the main drain loop — a handoff made right
        // after answering a question now continues instead of being dropped.
        // prepend: a mention in the post-resume reply is recent intent and runs
        // BEFORE work frozen at pause time (dax's call, 2026-07-08). Not for an
        // interrupted/failed reply — a partial cut short by abort/error isn't a
        // real handoff decision to act on.
        if (this.chaining && !interrupted) {
          const proposed = await this.proposeChain(
            asker.persona.id,
            pq.heldQueue,
            { prepend: true },
          )
          if (proposed.length > 0) {
            const proposals = proposed.map((t) => ({
              fromId: asker.persona.id,
              target: t,
            }))
            if (this.routingMode === "supervised") {
              // supervised: same shared path as the drain tail. Paused → the
              // decision is now part of the held work; synchronous resolution
              // → fall through and resume the held queue below.
              if (
                this.superviseProposals(proposals, pq.heldQueue, {
                  prepend: true,
                })
              ) {
                await this.emitWorkspace()
                await this.saveCurrent()
                return
              }
            } else {
              // semi/manual: pause for approval instead of continuing the drain.
              this.pendingRoute = { proposals, heldQueue: pq.heldQueue }
              this.emitRoutingProposed()
              await this.emitWorkspace()
              await this.saveCurrent()
              return
            }
          }
        }
      }

      // Restore the held queue (fresh mentions already prepended) and continue.
      this.queue = pq.heldQueue
      this.noticeQueueOrder(heldIds)
      const paused = await this.drainQueue()
      if (paused) {
        await this.emitWorkspace()
        await this.saveCurrent()
        return
      }
      this.queue = []
      await this.endTurn()
      await this.saveCurrent()
      return
    }

    // ── Normal (non-paused) flow ──────────────────────────────────────────
    this.post("user", "You", trimmed, undefined, undefined, images)

    const initial = this.resolveTargets(trimmed)
    if (initial.length === 0) {
      this.notice("No active participants to route to.", "info")
      return
    }

    this.queue = [...initial]
    this.aborted = false
    this.runningAgentId = initial[0]?.persona.id ?? null
    this.emit("turn", {
      phase: "start",
      targets: initial.map((t) => t.persona.id),
      agentId: this.runningAgentId,
    })

    // Drain the queue — shared method handles questions, chaining, and parallel waves.
    const paused = await this.drainQueue()
    if (paused) {
      await this.emitWorkspace()
      await this.saveCurrent()
      return
    }

    // Goal terminated by abort. Set before endTurn so its completion guard
    // doesn't overwrite the status. A user/planner cancel (goalCancelled)
    // resolves to "cancelled"; any other abort to "failed".
    if (
      this.aborted &&
      this.goalText !== null &&
      this.goalStatus === "running"
    ) {
      if (this.goalCancelled) {
        this.resolveGoal("cancelled")
      } else {
        this.resolveGoal("failed")
      }
      // Aborting during the INITIAL drain of an eval-mode goal means runGoalEval
      // never ran, so its finally never restored the fallback agent (and
      // plan-aware routing flag) that submitGoal suppressed. Restore both here
      // so the room isn't left with automatic no-mention routing silently disabled.
      if (this.goalMode === "eval") {
        this.fallbackAgentId = this.goalEvalSavedFallback
        this.planAwareRoutingEnabled =
          this.goalEvalSavedPlanAwareRouting ?? true
      }
    }
    this.queue = []
    await this.endTurn()
    await this.saveCurrent()
  }

  /** Pull the next group off the queue: a contiguous run of parallel-flagged
   *  agents (a concurrent wave), or a single non-parallel agent (serial). */
  protected nextGroup(): Participant[] {
    const first = this.queue.shift()!
    const group = [first]
    if (first.parallel) {
      while (this.queue.length > 0 && this.queue[0].parallel)
        group.push(this.queue.shift()!)
    }
    return group
  }

  /** The concurrency lane an agent runs on. Same-lane agents are serialized;
   *  different lanes run concurrently. All local models share one lane because
   *  llama-server runs --parallel 1; each cloud provider is its own lane. */
  protected laneOf(p: Participant): string {
    const provider = p.persona.model ? p.persona.model.split("/")[0] : "local"
    return provider === "local" ? "local" : `cloud:${provider}`
  }

  /** Run a group concurrently. All members see the same pre-wave transcript.
   *  Per-lane serialization keeps local agents one-at-a-time; cloud agents on
   *  distinct endpoints run truly in parallel. Results come back in group order. */
  protected async runWave(
    group: Participant[],
  ): Promise<Array<RunOutput | null>> {
    const contexts = new Map(group.map((p) => [p, this.buildContext(p)]))
    const laneTail = new Map<string, Promise<unknown>>()

    return Promise.all(
      group.map((p) => {
        const ctx = contexts.get(p) ?? { text: "" }
        const task = () => this.runAgent(p, ctx)
        const lane = this.laneOf(p)
        // Local lane is single-slot: chain tasks so they never overlap.
        if (lane === "local") {
          const prev = laneTail.get(lane) ?? Promise.resolve()
          const result = prev.then(task)
          laneTail.set(
            lane,
            result.catch(() => {}),
          )
          return result
        }
        // Cloud lanes: independent endpoints, run immediately/concurrently.
        return task()
      }),
    )
  }

  /** Execute one agent end to end: snapshot, prompt/followUp, snapshot, diff.
   *  Does NOT post — the caller posts results in group order to keep the
   *  transcript deterministic. */
  protected async executeAgent(
    target: Participant,
    context: { text: string; images?: string[] },
    mode: "prompt" | "followUp",
  ): Promise<RunOutput | null> {
    // Remote rooms skip the full-tree diff (too slow over sshfs) — the receipt is
    // rebuilt from the agent's write/edit tool calls below instead.
    const before = this.remote ? undefined : await snapshot(this.workspaceDir)
    this.running.add(target)
    // Emitted on every agent start (never per token) so the client's
    // runningAgentId follows the drain — `turn start` alone left the status
    // bar stuck on the turn's first agent for the whole chain.
    this.runningAgentId = target.persona.id
    this.emit("turn", { phase: "agent", agentId: target.persona.id })
    // Acquire the local-model lock only for local agents (cloud agents bypass).
    const isLocal = this.laneOf(target) === "local"
    let lockAcquired = false
    try {
      if (isLocal && this.localLock) {
        // Labelled with the roomId so pipeline_status can name the holder.
        await this.localLock.acquire(this.roomId)
        lockAcquired = true
      }
      // Stop raced the lock wait: the agent is already in this.running (added
      // above), so abortCurrent() ran p.abort() on a session that never
      // streamed (a no-op) and cleared the queue — yet without this check the
      // turn would start the moment the slot frees, running work the user
      // already stopped. Real window with PIPELINE_LOCAL_SLOTS=1 + several
      // rooms (review 2026-08-24, #3). This is the START side; the F7 fix
      // below is the result side — nothing has run yet, so there is no
      // TurnResult to salvage and null (infra skip) is the honest outcome.
      // Chain serialization guarantees no new message can clear `aborted`
      // before this point (submit() queues behind the in-flight process()).
      if (this.aborted) return null
      // Turn timing starts after the lock: "how long was the agent active",
      // not "how long did it wait for the local model to free up".
      const startedAt = Date.now()
      const result =
        mode === "prompt"
          ? await target.run(context.text, context.images)
          : await target.followUp(context.text, context.images)
      const durationMs = Date.now() - startedAt
      // F7 (knownissues.md): previously `if (this.aborted) return null` here
      // discarded a real, populated TurnResult purely because the room's
      // abort flag was set — losing the model's partial reply even though
      // tool side-effects (files written before the stop) already happened.
      // session.prompt()/followUp() resolve normally even on abort or a
      // terminal provider error (tagging stopReason instead of rejecting; see
      // Participant.run()), so `result` is real content, not a stub. Room's
      // OWN abort flag takes priority when set (the room asked to stop, so
      // treat it as interrupted even if this particular turn happened to
      // finish naturally in the same instant) — otherwise fall back to what
      // the turn itself reported (a provider error with no explicit abort).
      const stopReason: "aborted" | "error" | undefined = this.aborted
        ? "aborted"
        : result.stopReason
      const after = this.remote ? undefined : await snapshot(this.workspaceDir)

      // Broadcast context usage and session stats after the turn — piggyback on status event.
      // The idle status already fires from Participant.run() finally block;
      // this second broadcast adds contextUsage and sessionStats to the payload.
      const usage = target.getContextUsage?.()
      const stats = target.getSessionStats?.()
      if (usage || stats) {
        const payload: Record<string, unknown> = {
          id: target.persona.id,
          status: "idle",
        }
        if (usage) payload.contextUsage = usage
        if (stats) payload.sessionStats = stats
        this.emit("status", payload)
      }
      // A turn appended to the shared transcript — refresh the room gauge so
      // `ctx:` tracks the transcript that just grew. UNCONDITIONAL: the refresh
      // must not hinge on this agent's per-seat `usage` being present (a turn
      // that auto-compacted mid-generation can report tokens:null), because the
      // room gauge counts the TRANSCRIPT, not this seat. Always broadcast at run
      // end; getRoomUsage() recomputes from the transcript.
      this.broadcastSettings()

      return {
        target,
        reply: result.text,
        activity: result.activity,
        reasoning: result.reasoning,
        parts: result.parts,
        // A question from an interrupted/failed turn isn't a real pause request
        // — the turn didn't end the normal way a pause is supposed to.
        question: stopReason ? undefined : result.question,
        questionOptions: stopReason ? undefined : result.questionOptions,
        stopReason,
        errorMessage: result.errorMessage,
        durationMs,
        receipt:
          before && after
            ? diffSnapshots(before, after, target.persona.id)
            : receiptFromActivity(result.activity, target.persona.id),
      }
    } catch (err) {
      this.notice(
        `@${target.persona.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      )
      target.cursor = this.transcript.length
      return null
    } finally {
      if (lockAcquired) this.localLock?.release(this.roomId)
      this.running.delete(target)
    }
  }

  /** Run one agent via prompt. Thin wrapper around executeAgent. */
  protected runAgent(
    target: Participant,
    context: { text: string; images?: string[] },
  ): Promise<RunOutput | null> {
    return this.executeAgent(target, context, "prompt")
  }

  /** Follow-up one agent via session.followUp(). Thin wrapper around executeAgent.
   *  Used for self-chaining (ask_user resume) — guaranteed to be the next thing
   *  the agent processes. */
  protected followUpAgent(
    target: Participant,
    context: { text: string; images?: string[] },
  ): Promise<RunOutput | null> {
    return this.executeAgent(target, context, "followUp")
  }

  /** Serializable snapshot of a pending routing proposal (for state bootstrap),
   *  or null when nothing is awaiting approval. */
  getPendingRoute(): {
    proposals: Array<{ from: string; target: string; targetName: string }>
  } | null {
    if (!this.pendingRoute) return null
    return {
      proposals: this.pendingRoute.proposals.map((p) => ({
        from: p.fromId,
        target: p.target.persona.id,
        targetName: p.target.persona.name,
      })),
    }
  }

  /** Shared drain loop — replaces the 4 duplicated inline loops.
   *  Returns true if the pipeline was paused by an ask_user (caller should return).
   *  Handles parallel-wave questions correctly: posts ALL results from the wave
   *  before pausing on the first question, so no agent output is silently dropped. */
  protected async drainQueue(): Promise<boolean> {
    while (this.queue.length > 0 && !this.aborted) {
      const group = this.nextGroup()
      if (group.length > 1) {
        this.notice(
          `running ${group.length} in parallel: ${group.map((g) => `@${g.persona.id}`).join(" ")}`,
        )
        this.emit("turn", {
          phase: "parallel",
          targets: group.map((g) => g.persona.id),
        })
      }

      const results = await this.runWave(group)

      // Collect which results have questions (we pause on the first one,
      // but still post ALL results from this wave to avoid data loss).
      let paused = false
      let pauseAskerId: string | null = null
      let pauseQuestion: string | null = null
      let pauseOptions: string[] | undefined
      const waveProposals: RouteProposal[] = []

      for (const out of results) {
        // F7: only a genuine infra-level failure (null) is skipped now — an
        // interrupted/failed turn (out.stopReason set) still carries a real,
        // partial reply that must be posted, not silently dropped. It's just
        // not eligible to open a pause or chain further (checked below).
        if (!out) continue
        const interrupted = !!out.stopReason

        if (out.question && !paused && !interrupted) {
          // First question in this wave — remember it, but don't return yet.
          paused = true
          pauseAskerId = out.target.persona.id
          pauseQuestion = out.question
          pauseOptions = out.questionOptions
        }

        // Post the result (with question field if applicable), tagging an
        // interrupted/failed reply with an explicit marker so the transcript
        // stays honest about why the turn ended the way it did.
        const marker =
          out.stopReason === "aborted"
            ? " _(interrupted — partial)_"
            : out.stopReason === "error"
              ? ` _(failed — partial${out.errorMessage ? `: ${out.errorMessage}` : ""})_`
              : ""
        // Stamp the turn's handoff decision on the entry BEFORE it's consumed
        // below — a tool-only handoff is otherwise invisible in the transcript
        // and the next agent reads as taking over at random. Peek, don't take:
        // proposeChain still owns consumption. An interrupted or non-chaining
        // turn shows no stamp AND discards the registration — a partial turn's
        // handoff isn't a real decision, and nothing will ever consume it (it
        // would fire, stale, on this agent's next turn otherwise).
        let handoffTo = this.registry.peekHandoff?.(out.target.persona.id)
        if (handoffTo && (interrupted || !this.chaining)) {
          this.registry.takeHandoff(out.target.persona.id)
          handoffTo = undefined
        }
        this.post(
          out.target.persona.id,
          out.target.persona.name,
          turnBody(out.reply, out.question, out.activity) + marker,
          out.activity,
          out.reasoning,
          undefined,
          out.question,
          out.questionOptions,
          out.durationMs,
          handoffTo,
          appendBodyMarker(out.parts, marker),
        )
        if (receiptHasChanges(out.receipt)) this.emit("receipt", out.receipt)
        out.target.cursor = this.transcript.length

        // Plan adoption: if this turn actively worked a plan (create/claim/
        // update — not a read-only list/get), that becomes the plan this room
        // routes by. Runs BEFORE proposeChain so a plan created this very turn
        // is routable at this turn's end. Read-only plan calls never adopt, so
        // a stale plan can't be picked up just by an agent glancing at it.
        const adopted = planAdoptionId(out.activity ?? [])
        if (adopted) this.activePlanId = adopted

        // Chain from this reply (even if it had a question — the question is
        // posted as part of the message, and a handoff call earlier in the
        // same turn still registers and chains). An interrupted/failed turn
        // does NOT chain — a partial reply cut short by an abort or provider
        // error isn't a real handoff decision to act on.
        if (this.chaining && !interrupted) {
          const proposed = await this.proposeChain(
            out.target.persona.id,
            this.queue,
          )
          for (const t of proposed) {
            if (!waveProposals.some((wp) => wp.target === t)) {
              waveProposals.push({ fromId: out.target.persona.id, target: t })
            }
          }
        }

        // Inject work receipt into the next agent in queue (if there is one and there are changes).
        if (receiptHasChanges(out.receipt) && this.queue.length > 0) {
          const nextTarget = this.queue[0]
          await nextTarget.sendCustomMessage(
            {
              customType: "work_receipt",
              content: formatReceipt(out.receipt),
              display: false,
            },
            { deliverAs: "nextTurn" },
          )
        }
      }

      // If we encountered a question in this wave, pause now (after all wave results are posted).
      if (paused) {
        this.pendingQuestion = {
          askerId: pauseAskerId!,
          heldQueue: [...this.queue],
        }
        this.queue = []
        this.emit("turn", {
          phase: "pause",
          askerId: pauseAskerId!,
          question: pauseQuestion!,
          options: pauseOptions,
        })
        return true
      }

      // semi/manual: if any handoffs were proposed this wave, pause for approval
      // before running them. The held queue resumes after the human decides.
      // supervised: same pendingRoute machinery, but the approver is the
      // supervisor agent — or the set resolves synchronously (cap escape /
      // supervisor auto-accept / degradation) and the drain just continues.
      if (waveProposals.length > 0) {
        if (this.routingMode === "supervised") {
          if (this.superviseProposals(waveProposals, this.queue)) {
            this.queue = []
            return true
          }
          continue
        }
        this.pendingRoute = {
          proposals: waveProposals,
          heldQueue: [...this.queue],
        }
        this.queue = []
        this.emitRoutingProposed()
        return true
      }
    }
    return false
  }

  /** Stop everything: clear the pending queue and abort every running agent
   *  (a parallel wave can have several in flight at once). */
  async abortCurrent(): Promise<boolean> {
    this.aborted = true
    // Mark an in-flight goal as cancelled. The goal-eval loop resets `aborted`
    // each iteration, so a separate sticky flag is what actually makes it stop
    // (see runGoalEval). submitGoal() clears it for the next goal run.
    if (this.goalText !== null && this.goalStatus === "running") {
      this.goalCancelled = true
    }
    const had =
      this.queue.length > 0 ||
      this.running.size > 0 ||
      this.pendingQuestion !== null ||
      this.pendingRoute !== null
    this.queue = []
    this.pendingQuestion = null
    this.pendingRoute = null
    // In-flight supervised decision: the ephemeral route-supervisor session is
    // not a Participant, so the running-set sweep below never reaches it. Its
    // outcome is already inert (pendingRoute identity guard) — aborting just
    // stops paying for a micro-turn that decides into the void.
    this.supervisorAbort?.()
    this.supervisorAbort = null
    await Promise.all([...this.running].map((p) => p.abort()))
    return had
  }

  // ── Abstract members implemented by the layered subclasses ─────────────
  protected abstract broadcastSettings(): void
  protected abstract buildConversation(): Conversation
  protected abstract broadcastConversations(): Promise<void>
  protected abstract resolveGoal(
    status: "completed" | "failed" | "cancelled",
    reason?: string,
  ): void
  protected abstract runGoalEval(): Promise<void>
  protected abstract proposeChain(
    fromId: string,
    target: Participant[],
    opts?: { prepend?: boolean },
  ): Promise<Participant[]>
  protected abstract superviseProposals(
    proposals: RouteProposal[],
    held: Participant[],
    opts?: { prepend?: boolean },
  ): boolean
  protected abstract emitRoutingProposed(): void
  protected abstract handleSlashCommand(text: string): Promise<boolean>
}
