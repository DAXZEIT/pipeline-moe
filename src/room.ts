// The Room: shared transcript + serial turn queue + @mention routing + work
// receipts. One room per process. All model work is serialised here, which
// also matches llama-server running with --parallel 1.

import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process"
import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import { config } from "./config.js"
import { diffSnapshots, listWorkspace, receiptFromActivity, receiptHasChanges, snapshot } from "./receipts.js"
import type { Registry } from "./registry.js"
import type { Participant } from "./participant.js"
import type { ConversationStore } from "./store.js"
import { conversationMeta } from "./store.js"
import type { SseHub, SseEventName } from "./sse.js"
import type { LocalModelLock } from "./local-model-lock.js"
import { goalEvalPrompt } from "./personas.js"
import { findPlanById, nextStepOwner, planAdoptionId } from "./plan-routing.js"
import { TaskBoard } from "./task-board.js"
import type {
  Conversation,
  ConversationMeta,
  Persona,
  RoomTask,
  RouteDecision,
  RoutingMode,
  ToolActivity,
  TranscriptEntry,
  WorkReceipt,
} from "./types.js"

/** Produce a compact one-line summary of a work receipt for injection into the next agent's context. */
function formatReceipt(r: WorkReceipt): string {
  const parts: string[] = []
  if (r.created.length > 0) parts.push(`created: ${r.created.join(", ")}`)
  if (r.modified.length > 0) parts.push(`modified: ${r.modified.join(", ")}`)
  if (r.deleted.length > 0) parts.push(`deleted: ${r.deleted.join(", ")}`)
  return `📋 Work receipt from @${r.participantId}: ${parts.join("; ")}`
}

/** State when the pipeline is paused waiting for a user response to an ask_user. */
interface PendingQuestion {
  askerId: string
  heldQueue: Participant[]
}

/** A proposed handoff awaiting human approval (semi/manual routing). */
interface RouteProposal {
  fromId: string
  target: Participant
}

/** State when routing is paused for human approval (semi/manual mode). The
 *  heldQueue is work already queued before the proposal; it resumes once the
 *  human approves / redirects / drops. */
interface PendingRoute {
  proposals: RouteProposal[]
  heldQueue: Participant[]
}

const MENTION_RE = /@(\w+)/g

/** What one agent produced in a turn, before it is posted to the transcript. */
interface RunOutput {
  target: Participant
  reply: string
  activity: ToolActivity[]
  reasoning?: string
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
}

function newConvId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export class Room {
  private transcript: TranscriptEntry[] = []
  private chain: Promise<void> = Promise.resolve()
  /** Agents currently mid-turn. >1 when a parallel wave is running. */
  private running = new Set<Participant>()
  /** Id of the agent currently mid-turn (last started). Kept in sync by
   *  executeAgent so the client's status bar follows chained drains instead
   *  of showing the turn's first agent forever. Used for UI targeting (steer). */
  private runningAgentId: string | null = null

  /** Fired once when a running goal reaches a terminal status. Set by the
   *  orchestrator on spawned sub-rooms to report back into the parent room —
   *  this is what closes the spawn_room loop without the spawner polling. */
  onGoalResolved: ((status: "completed" | "failed" | "cancelled") => void) | null = null

  /** Resolve the running goal: set status, broadcast, fire the parent callback.
   *  Single funnel for every terminal transition so onGoalResolved can't be
   *  missed by a new resolution site. */
  private resolveGoal(status: "completed" | "failed" | "cancelled", reason?: string): void {
    this.goalStatus = status
    this.emit("room", {
      type: `goal-${status}`,
      goalText: this.goalText,
      ...(reason ? { reason } : {}),
    })
    this.onGoalResolved?.(status)
  }
  /** Pending agents to run in the current routing pass. Mutated as agents chain. */
  private queue: Participant[] = []
  private aborted = false
  /** Routing mode. 'auto' chains @mentions directly (today's default); 'semi'
   *  pauses each proposed handoff for human approval; 'manual' honors no
   *  agent→agent chaining. The legacy `chaining` boolean is derived from this
   *  (auto/semi → on, manual → off) so existing settings, persistence, and tests
   *  keep working unchanged. */
  private routingMode: RoutingMode = "auto"
  private get chaining(): boolean { return this.routingMode !== "manual" }
  private set chaining(value: boolean) { this.routingMode = value ? "auto" : "manual" }
  /** Anti-loop: max chain hops per turn. Prevents A→B→A infinite loops. */
  private maxChainHops = 30
  private chainBudget = 0
  /** Set when an agent called ask_user — pipeline is paused until user responds. */
  private pendingQuestion: PendingQuestion | null = null
  /** Set in semi/manual mode when proposed handoffs await human approval. */
  private pendingRoute: PendingRoute | null = null
  /** Agent that handles messages with no @mention. null = first active. */
  private defaultAgentId: string | null = null
  /** Agent that receives routing fallback when no agent is @-mentioned in a reply. null = disabled. */
  private fallbackAgentId: string | null = "planner"
  /** When true, no-mention routing consults the active plan (`.pi/plans/`) first:
   *  if the next incomplete step has an `[agent]` owner prefix, route there
   *  instead of the generic fallback agent. Falls through to fallbackAgentId
   *  when there's no active plan, no owner prefix, or the owner is unavailable. */
  private planAwareRoutingEnabled = true
  /** Goal prompt if this room was started with a goal; null for interactive rooms. */
  private goalText: string | null = null
  /** Lifecycle status for goal-driven rooms. */
  private goalStatus: "idle" | "running" | "completed" | "failed" | "cancelled" = "idle"
  /** Set by abortCurrent() while a goal is running. Sticky for the whole goal
   *  run — NOT reset per eval iteration — so the goal-eval loop (which clears
   *  `aborted` on every pass) still terminates as "cancelled" instead of spinning
   *  to the next iteration. Cleared by submitGoal() for the next goal. */
  private goalCancelled = false
  /** Goal completion mode. "auto": complete when the pipeline drains naturally.
   *  "eval": after each drain, route to the evaluator to verify the goal and
   *  either dispatch more work or declare GOAL_MET. */
  private goalMode: "auto" | "eval" = "auto"
  /** Agent id that evaluates the goal in "eval" mode. */
  private goalEvaluator = "planner"
  /** Max eval iterations before the goal auto-fails (eval mode only). */
  private maxGoalIterations = 10
  /** Eval iterations consumed so far in the current goal run. */
  private goalIteration = 0
  /** Fallback agent saved while an eval-mode goal suppresses fallback routing.
   *  Restored when the eval loop terminates. */
  private goalEvalSavedFallback: string | null = null
  /** Plan-aware routing flag saved while an eval-mode goal suppresses it — same
   *  reason as goalEvalSavedFallback: the evaluator is invoked deliberately by
   *  the eval loop, so any other automatic no-mention routing would double up. */
  private goalEvalSavedPlanAwareRouting: boolean | null = null
  /** True when the eval loop returned because a drain paused on a question —
   *  tells runGoalEval's finally NOT to restore the fallback agent, since the
   *  loop resumes (via endTurn) once the answer arrives. */
  private goalEvalPausedOnQuestion = false
  /** Agents that already received the one-shot no-handoff menu (see
   *  proposeChain) in the current goal-eval iteration. Guarantees at most one
   *  menu re-prompt per agent per iteration — cleared at each iteration start
   *  and by submitGoal — so a model that never chooses is bounded by the goal
   *  iteration budget, not looped forever. */
  private noHandoffMenuUsed = new Set<string>()
  /** The plan THIS conversation has adopted — the ONLY plan plan-aware routing
   *  will consult (bare id). Set when an agent in this room mutates a plan
   *  (planAdoptionId), null until then. Deliberately in-memory and reset on a
   *  new goal / conversation load: a room that hasn't actively worked a plan
   *  routes by no plan, so a stale plan in the shared .pi/plans graveyard can
   *  never hijack a turn (the planner↔tester incident, 2026-07-09). */
  private activePlanId: string | null = null

  // ── Current conversation identity ──────────────────────────────────────────
  private convId = newConvId()
  private convTitle = "Discussion 1"
  private convCreatedAt = Date.now()
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly registry: Registry,
    private readonly hub: SseHub,
    private readonly store: ConversationStore,
    private readonly seedPersonas: Persona[],
    /** Logical room identifier — included in all SSE broadcasts for future room-scoped filtering. */
    readonly roomId: string = "default",
    /** Optional process-global lock for serializing local-model inference across rooms. */
    private readonly localLock?: LocalModelLock,
    /** Directory this room is scoped to: where file tools are confined, bash runs,
     *  work receipts snapshot, and the workspace listing looks. Defaults to the
     *  pipeline workspace. */
    private readonly workspaceDir: string = config.workspaceDir,
    /** True when the workspace is a remote (sshfs) mount. Walking the whole
     *  remote tree per turn would stall every action for ~a minute over the
     *  network, so work receipts and the live workspace listing are skipped
     *  for remote rooms. */
    private readonly remote: boolean = false,
    /** Shared task board. RoomManager passes the SAME instance to the Registry
     *  so the task_* tools mutate the board this room persists/broadcasts.
     *  Defaults to a private board (tests, direct construction). */
    private readonly taskBoard: TaskBoard = new TaskBoard(),
  ) {
    this.taskBoard.onChange = () => {
      this.broadcastTasks()
      this.scheduleSave()
    }
  }

  /** Default thinking level for agents without a per-agent override.
   *  Mutable — can be changed per-room via the Settings panel.
   *  Propagated to the Registry so new participants use it. */
  private defaultThinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" = config.thinkingLevel

  /** Whether cloud models are allowed in this room. Mutable — can be toggled
   *  per-room via the Settings panel. Propagated to the Registry so new
   *  participants use the room's policy. */
  private allowCloud: boolean = config.allowCloud

  /** Reserve tokens for auto-compaction. Mutable — can be changed per-room via
   *  the Settings panel. Propagated to the Registry so new participants use
   *  the room's value. */
  private compactionReserveTokens: number = 38000

  /** Broadcast wrapper: tags object payloads with roomId; arrays pass through unmodified. */
  private emit(event: SseEventName, data: unknown): void {
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

  private async emitWorkspace(): Promise<void> {
    this.emit("workspace", await this.getWorkspaceListing())
  }

  /** Number of participants (active + inactive) in this room's registry. */
  rosterLength(): number {
    return this.registry.roster().length
  }

  getGoalText(): string | null { return this.goalText }
  getGoalStatus(): "idle" | "running" | "completed" | "failed" | "cancelled" { return this.goalStatus }

  /** Start a goal-driven pipeline run. Sets goalText/status and fires the first turn.
   *  In "eval" mode the evaluator agent verifies the goal after each drain and
   *  drives an iterative dispatch loop until it declares GOAL_MET or the iteration
   *  budget is exhausted. */
  submitGoal(
    text: string,
    opts?: { mode?: "auto" | "eval"; evaluator?: string; maxIterations?: number },
  ): void {
    this.goalText = text
    this.goalStatus = "running"
    this.goalMode = opts?.mode ?? "auto"
    this.goalEvaluator = opts?.evaluator?.trim() || "planner"
    this.maxGoalIterations = Math.max(1, Math.min(50, Math.round(opts?.maxIterations ?? 10)))
    this.goalIteration = 0
    this.goalCancelled = false
    this.noHandoffMenuUsed.clear()
    // A new goal is a fresh workflow: drop any plan adopted by prior work so
    // this goal only routes by a plan its own agents actually touch.
    this.activePlanId = null
    // In eval mode the eval loop is the sole router: the evaluator is invoked
    // deliberately after every natural drain. Leaving generic fallback routing
    // active would re-invoke the evaluator (when it is also the fallback agent)
    // with a misleading "routing fallback" context — doubling invocations and
    // draining the iteration budget. Suppress fallback for the whole goal run
    // (initial drain + eval loop); runGoalEval's finally restores it.
    if (this.goalMode === "eval") {
      this.goalEvalSavedFallback = this.fallbackAgentId
      this.fallbackAgentId = null
      this.goalEvalSavedPlanAwareRouting = this.planAwareRoutingEnabled
      this.planAwareRoutingEnabled = false
    }
    this.submit(text)
  }

  getGoalMode(): "auto" | "eval" { return this.goalMode }

  /** Expose the registry for server-side route handlers. */
  getRegistry(): Registry {
    return this.registry
  }

  getChaining(): boolean {
    return this.chaining
  }

  setChaining(value: boolean): void {
    this.chaining = value
    this.broadcastSettings()
    void this.saveCurrent()
  }

  getRoutingMode(): RoutingMode {
    return this.routingMode
  }

  setRoutingMode(mode: RoutingMode): void {
    this.routingMode = mode
    this.broadcastSettings()
    void this.saveCurrent()
  }

  getDefaultAgent(): string | null {
    return this.defaultAgentId
  }

  /** Set the agent that handles un-mentioned messages. null = first active. */
  setDefaultAgent(id: string | null): void {
    if (id !== null && !this.registry.has(id)) throw new Error(`unknown participant "${id}"`)
    this.defaultAgentId = id
    this.broadcastSettings()
    void this.saveCurrent()
  }

  getFallbackAgent(): string | null {
    return this.fallbackAgentId
  }

  /** Set the agent that receives routing fallback. null = disabled. */
  setFallbackAgent(id: string | null): void {
    if (id !== null && !this.registry.has(id)) throw new Error(`unknown participant "${id}"`)
    this.fallbackAgentId = id
    this.broadcastSettings()
    void this.saveCurrent()
  }

  getPlanAwareRouting(): boolean {
    return this.planAwareRoutingEnabled
  }

  setPlanAwareRouting(enabled: boolean): void {
    this.planAwareRoutingEnabled = enabled
    this.broadcastSettings()
    void this.saveCurrent()
  }

  getMaxChainHops(): number {
    return this.maxChainHops
  }

  setMaxChainHops(n: number): void {
    this.maxChainHops = Math.max(1, Math.min(100, Math.round(n)))
    this.broadcastSettings()
    void this.saveCurrent()
  }

  // ── Default thinking level ──────────────────────────────────────────────────

  getDefaultThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" {
    return this.defaultThinkingLevel
  }

  setDefaultThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): void {
    this.defaultThinkingLevel = level
    // Propagate to registry so new participants use the updated default.
    this.registry.setDefaultThinkingLevel(level)
    this.broadcastSettings()
    void this.saveCurrent()
  }

  // ── Allow cloud toggle ─────────────────────────────────────────────────────

  getAllowCloud(): boolean {
    return this.allowCloud
  }

  setAllowCloud(value: boolean): void {
    this.allowCloud = value
    // Propagate to registry so new participants use the updated policy.
    this.registry.setAllowCloud(value)
    this.broadcastSettings()
    void this.saveCurrent()
  }

  // ── Compaction reserve tokens ────────────────────────────────────────────

  getCompactionReserveTokens(): number {
    return this.compactionReserveTokens
  }

  setCompactionReserveTokens(value: number): void {
    this.compactionReserveTokens = Math.max(5000, Math.min(100000, Math.round(value)))
    // Propagate to registry so new participants use the updated value.
    this.registry.setCompactionReserveTokens(this.compactionReserveTokens)
    this.broadcastSettings()
    void this.saveCurrent()
  }

  private broadcastSettings(): void {
    this.emit("settings", {
      chaining: this.chaining,
      routingMode: this.routingMode,
      defaultAgent: this.defaultAgentId,
      fallbackAgent: this.fallbackAgentId,
      planAwareRouting: this.planAwareRoutingEnabled,
      maxChainHops: this.maxChainHops,
      defaultThinkingLevel: this.defaultThinkingLevel,
      allowCloud: this.allowCloud,
      compactionReserveTokens: this.compactionReserveTokens,
    })
  }

  // ── Conversation lifecycle ──────────────────────────────────────────────────

  /** Load the most recent saved conversation, or seed a fresh one. Wires autosave. */
  async init(): Promise<void> {
    await this.store.init()
    const metas = await this.store.list()
    const latest = metas[0] ? await this.store.read(metas[0].id) : null
    if (latest) {
      await this.applyConversation(latest)
    } else {
      await this.startFresh(
        "Discussion 1",
        this.seedPersonas.map((p) => ({ ...p, active: true })),
      )
    }
    // From now on, any roster change autosaves the current conversation.
    this.registry.onChange = () => this.scheduleSave()
  }

  private buildConversation(): Conversation {
    return {
      id: this.convId,
      title: this.convTitle,
      createdAt: this.convCreatedAt,
      updatedAt: Date.now(),
      chaining: this.chaining,
      routingMode: this.routingMode,
      defaultAgent: this.defaultAgentId,
      fallbackAgent: this.fallbackAgentId,
      planAwareRouting: this.planAwareRoutingEnabled,
      defaultThinkingLevel: this.defaultThinkingLevel,
      allowCloud: this.allowCloud,
      compactionReserveTokens: this.compactionReserveTokens,
      personas: this.registry.personaStates(),
      transcript: this.transcript,
      tasks: this.taskBoard.serialize(),
    }
  }

  /** Persist the current conversation and push the refreshed list to clients. */
  async saveCurrent(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.store.write(this.buildConversation())
    await this.broadcastConversations()
  }

  /** Debounced autosave, for bursty roster mutations. */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.saveCurrent()
    }, 400)
  }

  async getConversations(): Promise<{ currentId: string; list: ConversationMeta[] }> {
    return { currentId: this.convId, list: await this.store.list() }
  }

  private async broadcastConversations(): Promise<void> {
    this.emit("conversations", {
      currentId: this.convId,
      list: await this.store.list(),
    })
  }

  getTasks(): RoomTask[] {
    return this.taskBoard.list()
  }

  private broadcastTasks(): void {
    this.emit("tasks", { tasks: this.taskBoard.list() })
  }

  /** True while an agent is running or queued — editing a roster member's
   *  session (which disposes+recreates it) is unsafe during this window. */
  isBusy(): boolean {
    return this.running.size > 0 || this.queue.length > 0 || this.pendingQuestion !== null || this.pendingRoute !== null
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

  private ensureIdle(): void {
    if (this.running.size > 0 || this.queue.length > 0 || this.pendingQuestion !== null || this.pendingRoute !== null) {
      throw new Error("a turn is running — press Stop before switching discussions")
    }
  }

  /** Root for a conversation's on-disk agent sessions (pi JSONL files), or
   *  null when persistence is off. Lives next to the conversation JSON so a
   *  room's data — transcript AND agent memories — travels as one directory. */
  private agentSessionRoot(convId: string): string | null {
    // Test doubles of ConversationStore may not expose baseDir — treat that
    // as persistence off (in-memory sessions, the pre-persistence behavior).
    const base = this.store.baseDir as string | undefined
    return config.persistAgentSessions && base ? resolve(base, "agents", convId) : null
  }

  /** Become a brand-new empty conversation with the given roster. */
  private async startFresh(title: string, personas: Conversation["personas"]): Promise<void> {
    this.convId = newConvId()
    this.convTitle = title
    this.convCreatedAt = Date.now()
    this.transcript = []
    this.taskBoard.load([]) // fresh discussion → empty board
    this.broadcastTasks()
    this.defaultAgentId = null // fresh discussion → first active is the default
    // New conversation id → empty session root → every agent starts fresh.
    // (Optional call: test doubles of Registry don't implement it.)
    this.registry.setSessionRoot?.(this.agentSessionRoot(this.convId))
    await this.registry.reset(personas)
    this.emit("transcript", this.transcript)
    this.broadcastSettings()
    await this.saveCurrent()
  }

  /** Make a saved conversation the live one. Agents whose on-disk pi session
   *  is restored resume with their private context and saved cursor; the rest
   *  get fresh sessions that replay the transcript on their next turn. */
  private async applyConversation(conv: Conversation): Promise<void> {
    this.convId = conv.id
    this.convTitle = conv.title
    this.convCreatedAt = conv.createdAt
    this.registry.setSessionRoot?.(this.agentSessionRoot(conv.id))
    this.routingMode = conv.routingMode ?? (conv.chaining ? "auto" : "manual")
    this.defaultAgentId = conv.defaultAgent ?? null
    this.fallbackAgentId = conv.fallbackAgent ?? "planner"
    this.planAwareRoutingEnabled = conv.planAwareRouting ?? true
    // Adoption is in-memory only: a freshly loaded conversation has adopted no
    // plan until one of its agents touches a plan again — safest default (no
    // stale plan can route on restart mid-workflow).
    this.activePlanId = null
    // Back-compat: older saves don't have these fields — fall back to config defaults.
    if (conv.defaultThinkingLevel) {
      const level = conv.defaultThinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
      this.defaultThinkingLevel = level
      this.registry.setDefaultThinkingLevel(level)
    }
    // Back-compat: older saves don't have allowCloud — fall back to config default.
    this.allowCloud = conv.allowCloud ?? config.allowCloud
    this.registry.setAllowCloud(this.allowCloud)
    // Back-compat: older saves don't have compactionReserveTokens — fall back to 38000.
    this.compactionReserveTokens = conv.compactionReserveTokens ?? 38000
    this.registry.setCompactionReserveTokens(this.compactionReserveTokens)

    // Guard against a corrupt save with an empty roster (e.g. a botched
    // out-of-band edit / mid-turn restart). An empty roster would brick the UI
    // permanently — and since init() loads the most recent conversation, it
    // would do so on every boot. Fall back to the seed personas and re-persist.
    let healed = false
    let personas = conv.personas
    if (personas.length === 0) {
      personas = this.seedPersonas.map((p) => ({ ...p, active: true }))
      healed = true
    }
    await this.registry.reset(personas)
    // Agents with a restored on-disk session keep their saved cursor (their
    // context already covers the transcript up to it); fresh sessions start at
    // cursor=0 and catch up on the whole transcript on their next turn.
    this.transcript = conv.transcript.map((e) => ({ ...e }))
    this.taskBoard.load(conv.tasks ?? []) // back-compat: older saves have no board
    this.broadcastSettings()
    this.emit("transcript", this.transcript)
    this.broadcastTasks()
    if (healed) {
      this.notice(`"${conv.title}" had an empty roster — restored the seed agents.`, "info")
      await this.saveCurrent() // make the repair stick on disk
    }
    await this.broadcastConversations()
  }

  /** Start a new discussion, inheriting the current roster. Returns its metadata. */
  async newConversation(title?: string): Promise<ConversationMeta> {
    this.ensureIdle()
    await this.saveCurrent()
    const personas = this.registry.personaStates()
    const count = (await this.store.list()).length
    await this.startFresh(title?.trim() || `Discussion ${count + 1}`, personas)
    return conversationMeta(this.buildConversation())
  }

  /** Start a new discussion with a preset roster. Returns its metadata. */
  async loadPreset(personas: Conversation["personas"], title?: string): Promise<ConversationMeta> {
    this.ensureIdle()
    await this.saveCurrent()
    const count = (await this.store.list()).length
    await this.startFresh(title?.trim() || `Discussion ${count + 1}`, personas)
    return conversationMeta(this.buildConversation())
  }

  /** Apply a preset roster to the current room — replaces agents in-place without
   *  changing the conversation id, title, or transcript. Persists immediately so
   *  the roster survives reboot. */
  async applyPreset(personas: Conversation["personas"]): Promise<ConversationMeta> {
    this.ensureIdle()
    // A preset replaces the roster wholesale — wipe this conversation's agent
    // sessions so a same-id persona doesn't wake up with the old one's memory.
    const root = this.agentSessionRoot(this.convId)
    if (root) await rm(root, { recursive: true, force: true })
    await this.registry.reset(personas)
    this.broadcastSettings()
    await this.saveCurrent()
    await this.broadcastConversations()
    return conversationMeta(this.buildConversation())
  }

  /** Switch to a saved discussion. No-op if already current. */
  async switchConversation(id: string): Promise<void> {
    this.ensureIdle()
    if (id === this.convId) return
    const conv = await this.store.read(id)
    if (!conv) throw new Error(`unknown conversation "${id}"`)
    await this.saveCurrent() // flush the one we're leaving
    await this.applyConversation(conv)
  }

  async renameConversation(id: string, title: string): Promise<void> {
    const clean = title.trim()
    if (!clean) throw new Error("title is required")
    if (id === this.convId) {
      this.convTitle = clean
      await this.saveCurrent()
      return
    }
    const conv = await this.store.read(id)
    if (!conv) throw new Error(`unknown conversation "${id}"`)
    conv.title = clean
    conv.updatedAt = Date.now()
    await this.store.write(conv)
    await this.broadcastConversations()
  }

  async deleteConversation(id: string): Promise<void> {
    this.ensureIdle()
    await this.store.remove(id)
    // The conversation's agent sessions go with it.
    const root = this.agentSessionRoot(id)
    if (root) await rm(root, { recursive: true, force: true })
    if (id === this.convId) {
      // Deleted the live one: fall back to the most recent remaining, else seed.
      const metas = await this.store.list()
      const next = metas[0] ? await this.store.read(metas[0].id) : null
      if (next) await this.applyConversation(next)
      else
        await this.startFresh(
          "Discussion 1",
          this.seedPersonas.map((p) => ({ ...p, active: true })),
        )
    } else {
      await this.broadcastConversations()
    }
  }

  private post(
    author: string,
    authorName: string,
    text: string,
    activity?: ToolActivity[],
    reasoning?: string,
    images?: string[],
    question?: string,
    questionOptions?: string[],
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
      ...(question && questionOptions && questionOptions.length > 0 ? { questionOptions } : {}),
    }
    this.transcript.push(entry)

    this.emit("message", entry)
    return entry
  }

  private notice(msg: string, level: "info" | "error" = "info"): void {
    this.emit("notice", { msg, level })
  }

  /** End the current turn — clears runningAgentId and broadcasts turn end. */
  private async endTurn(): Promise<void> {
    this.runningAgentId = null
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

  /** Matches the GOAL_MET completion token in any reasonable form. */
  private static readonly GOAL_MET_RE = /\bGOAL[\s_-]?MET\b/i

  /** Goal-eval loop (eval mode). After the pipeline drains naturally, route to
   *  the evaluator agent with a structured prompt. The evaluator verifies the
   *  goal independently (using its tools), then either:
   *    - declares GOAL_MET  → goal completes, loop exits; or
   *    - calls handoff(to)  → that agent runs (via drainQueue chaining), then
   *      the loop re-evaluates.
   *  Bounded by maxGoalIterations to guarantee termination. Called from within
   *  endTurn(); it drives drainQueue() directly and never re-enters endTurn(),
   *  so there is no recursion. */
  private async runGoalEval(): Promise<void> {
    const evaluator = this.registry.get(this.goalEvaluator)
    if (!evaluator || !evaluator.active) {
      // No evaluator available — fall back to auto-completion rather than hang
      // the goal in "running" forever.
      this.notice(`Goal eval: evaluator @${this.goalEvaluator} not available — completing goal without verification.`, "info")
      this.resolveGoal("completed")
      this.fallbackAgentId = this.goalEvalSavedFallback
      this.planAwareRoutingEnabled = this.goalEvalSavedPlanAwareRouting ?? true
      this.runningAgentId = null
      return
    }

    // Fallback routing is already suppressed (set null in submitGoal for the
    // whole eval-mode run). The finally restores the original fallback agent and
    // re-nulls runningAgentId per endTurn's documented contract.
    try {
      while (this.goalIteration < this.maxGoalIterations) {
        // Cancellation (abortCurrent / stop_room / Stop button) wins over
        // everything: end the goal as "cancelled" without another pass. Checked
        // here (between iterations) and again after the drain below.
        if (this.goalCancelled) {
          this.resolveGoal("cancelled")
          this.notice(`Goal cancelled on iteration ${this.goalIteration}.`, "info")
          return
        }
        this.goalIteration++
        // Each iteration's dispatches get a fresh one-shot no-handoff menu.
        this.noHandoffMenuUsed.clear()

        // Inject the structured eval context (invisible in the transcript).
        await evaluator.sendCustomMessage(
          {
            customType: "goal_eval",
            content: goalEvalPrompt(this.goalText!, this.goalIteration, this.maxGoalIterations),
            display: false,
          },
          { deliverAs: "nextTurn" },
        )
        this.emit("room", {
          type: "goal-eval",
          goalText: this.goalText,
          iteration: this.goalIteration,
          maxIterations: this.maxGoalIterations,
        })

        // Run the evaluator and any agents it dispatches via handoff chaining.
        this.queue = [evaluator]
        this.aborted = false
        this.chainBudget = 0
        this.runningAgentId = evaluator.persona.id
        this.emit("turn", { phase: "chain", from: null, targets: [evaluator.persona.id] })
        const paused = await this.drainQueue()

        // ask_user/ask_orchestrator pause inside an eval pass: the goal stays
        // "running" and we return with fallback suppression INTACT — the answer
        // resumes through process() → endTurn() → runGoalEval(), which picks
        // the loop back up. (Before this guard the loop clobbered the pause
        // and orphaned the held queue.)
        if (paused) {
          this.goalEvalPausedOnQuestion = true
          return
        }

        // Cancelled mid-drain — stop now, before reinterpreting the drain as a
        // completion or abort failure.
        if (this.goalCancelled) {
          this.resolveGoal("cancelled")
          this.notice(`Goal cancelled on iteration ${this.goalIteration}.`, "info")
          return
        }

        // Did the evaluator declare the goal met in its most recent message?
        if (this.evaluatorDeclaredGoalMet(evaluator.persona.id)) {
          this.resolveGoal("completed")
          return
        }

        // Turn aborted during this eval pass — give up.
        if (this.aborted) {
          this.resolveGoal("failed", "aborted")
          this.notice(`Goal eval aborted on iteration ${this.goalIteration}.`, "error")
          return
        }
      }

      // Iteration budget exhausted without GOAL_MET.
      this.resolveGoal("failed", "max-iterations")
      this.notice(`Goal eval exhausted after ${this.maxGoalIterations} iterations without GOAL_MET.`, "error")
    } finally {
      if (this.goalEvalPausedOnQuestion) {
        // Paused mid-eval: keep the fallback suppressed — the resumed loop
        // (re-entered via endTurn) still needs it off.
        this.goalEvalPausedOnQuestion = false
      } else {
        this.fallbackAgentId = this.goalEvalSavedFallback
        this.planAwareRoutingEnabled = this.goalEvalSavedPlanAwareRouting ?? true
        this.runningAgentId = null
      }
    }
  }

  /** True if the evaluator's most recent transcript message declares GOAL_MET. */
  private evaluatorDeclaredGoalMet(evaluatorId: string): boolean {
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      const e = this.transcript[i]
      if (e.author === evaluatorId) return Room.GOAL_MET_RE.test(e.text)
    }
    return false
  }

  /** Public snapshot of the live conversation — roster, transcript, settings.
   *  Used by room forking to copy this discussion into another room. */
  snapshotConversation(): Conversation {
    return this.buildConversation()
  }

  /** Adopt another room's conversation as this room's live discussion (fork).
   *  A NEW conversation id is minted, so agent sessions start fresh — the
   *  saved cursors are ignored (resumed=false forces 0) and every agent
   *  catches up on the full forked transcript on its first turn. The empty
   *  seed conversation created by init() is removed. */
  async adoptConversation(conv: Conversation, title?: string): Promise<void> {
    this.ensureIdle()
    const seedConvId = this.convId
    await this.applyConversation({
      ...conv,
      id: newConvId(),
      title: title?.trim() || conv.title,
      createdAt: Date.now(),
      transcript: conv.transcript.map((e) => ({ ...e })),
    })
    await this.saveCurrent()
    await this.store.remove(seedConvId)
    await this.broadcastConversations()
  }

  /** Truncate the shared transcript to its first `keep` entries. Agents whose
   *  cursor had advanced past the cut have the removed messages inside their
   *  private pi session — those sessions are rebuilt from scratch (they replay
   *  the kept transcript on their next turn). Agents still behind the cut are
   *  untouched. */
  async rollbackTo(keep: number): Promise<number> {
    this.ensureIdle()
    if (!Number.isInteger(keep) || keep < 0 || keep >= this.transcript.length) {
      throw new Error(`nothing to roll back (transcript has ${this.transcript.length} entries)`)
    }
    const removed = this.transcript.length - keep
    this.transcript = this.transcript.slice(0, keep)
    await this.registry.rollbackSessions(keep)
    this.emit("transcript", this.transcript)
    await this.saveCurrent()
    this.notice(`Rolled back ${removed} message${removed === 1 ? "" : "s"}.`, "info")
    return removed
  }

  /** Run a user shell command in the room's workspace and post `$ cmd` + its
   *  output to the shared transcript (author "shell") — Claude Code's `!`
   *  mode, but the result becomes context every agent sees on its next turn.
   *  No routing, no agent turn. Output is clipped so one
   *  `cat` of a huge file can't blow up the transcript. */
  async runShell(command: string): Promise<TranscriptEntry> {
    const output = await new Promise<{ text: string; code: number | string | null }>((done) => {
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
          const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null
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
  postShellRecord(command: string, output: string, exitCode: number | string | null): TranscriptEntry {
    const max = 8000
    const clipped = output.length > max ? `${output.slice(0, max)}\n… (+${output.length - max} chars)` : output
    // 130/143 = 128+SIGINT/SIGTERM: the user stopped the command (Ctrl+C on a
    // ping, say). Label it as deliberate — "(exit 130)" reads as a failure and
    // sends agents chasing an error that never happened.
    const interrupted = exitCode === 130 || exitCode === 143 || exitCode === "SIGINT" || exitCode === "SIGTERM"
    const suffix = interrupted
      ? "\n(stopped by user — partial output, not an error)"
      : exitCode === "timeout"
        ? "\n(timed out after 30s — partial output)"
        : exitCode !== 0 && exitCode !== null
          ? `\n(exit ${exitCode})`
          : ""
    const text = `$ ${command}\n${clipped.trimEnd() || "(no output)"}` + suffix
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
  private resolveTargets(text: string): Participant[] {
    const mentioned = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = MENTION_RE.exec(text)) !== null) mentioned.add(m[1].toLowerCase())

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
  private resolveHandoff(selfId: string): Participant[] {
    const to = this.registry.takeHandoff(selfId)
    if (!to || to === selfId) return []
    const p = this.registry.get(to)
    if (!p || !p.active) return []
    return [p]
  }

  /** Build the prompt for a participant: the room lines it hasn't seen yet
   *  (excluding its own past messages, which live in its session memory).
   *  Also collects images from the last user message for vision support. */
  private buildContext(p: Participant): { text: string; images?: string[] } {
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
  private noticeQueueOrder(heldIds: Set<string>): void {
    if (this.queue.length === 0) return
    const order = this.queue
      .map((p) => `@${p.persona.id}${heldIds.has(p.persona.id) ? " (held)" : ""}`)
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
    this.chain = this.chain.then(() => this.processOrchestratorReport(text, targetAgentId)).catch((err) => {
      this.notice(`Room error: ${err instanceof Error ? err.message : String(err)}`, "error")
    })
  }

  private async processOrchestratorReport(text: string, targetAgentId: string): Promise<void> {
    this.post("orchestrator", "Orchestrator", text)
    if (this.pendingQuestion || this.pendingRoute) {
      this.notice(`Sub-room report delivered — @${targetAgentId} will see it after the current pause.`, "info")
      await this.saveCurrent()
      return
    }
    const target = this.registry.get(targetAgentId)
    if (!target || !target.active) {
      this.notice(`Sub-room report posted, but @${targetAgentId} is not available to act on it.`, "info")
      await this.saveCurrent()
      return
    }
    this.queue = [target]
    this.aborted = false
    this.chainBudget = 0
    this.runningAgentId = target.persona.id
    this.emit("turn", { phase: "start", targets: [targetAgentId], agentId: targetAgentId })
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
    this.chain = this.chain.then(() => this.process(text, images)).catch((err) => {
      this.notice(`Room error: ${err instanceof Error ? err.message : String(err)}`, "error")
    })
  }

  private async process(text: string, images?: string[]): Promise<void> {
    const trimmed = text.trim()
    this.chainBudget = 0 // reset chain budget for this turn

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
      if (!asker || !asker.active) {
        this.notice(`@${pq.askerId} is no longer active — resuming held queue.`, "info")
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
        const marker = result.stopReason === "aborted"
          ? " _(interrupted — partial)_"
          : result.stopReason === "error"
            ? ` _(failed — partial${result.errorMessage ? `: ${result.errorMessage}` : ""})_`
            : ""
        // Post with question field if the asker asked another question.
        this.post(asker.persona.id, asker.persona.name, (result.reply || "(no response)") + marker, result.activity, result.reasoning, undefined, result.question, result.questionOptions)
        if (receiptHasChanges(result.receipt)) this.emit("receipt", result.receipt)
        asker.cursor = this.transcript.length

        // If the asker asked ANOTHER question, re-pause. Not for an
        // interrupted/failed reply — its "question" (if any) isn't a real
        // pause request (executeAgent already nulls it, checked again here
        // for a locally-obvious invariant rather than trusting a call away).
        if (result.question && !interrupted) {
          this.pendingQuestion = { askerId: asker.persona.id, heldQueue: pq.heldQueue }
          this.emit("turn", { phase: "pause", askerId: asker.persona.id, question: result.question, options: result.questionOptions })
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
          const proposed = await this.proposeChain(asker.persona.id, pq.heldQueue, { prepend: true })
          if (proposed.length > 0) {
            // semi/manual: pause for approval instead of continuing the drain.
            this.pendingRoute = {
              proposals: proposed.map((t) => ({ fromId: asker.persona.id, target: t })),
              heldQueue: pq.heldQueue,
            }
            this.emitRoutingProposed()
            await this.emitWorkspace()
            await this.saveCurrent()
            return
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
    this.emit("turn", { phase: "start", targets: initial.map((t) => t.persona.id), agentId: this.runningAgentId })

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
    if (this.aborted && this.goalText !== null && this.goalStatus === "running") {
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
        this.planAwareRoutingEnabled = this.goalEvalSavedPlanAwareRouting ?? true
      }
    }
    this.queue = []
    await this.endTurn()
    await this.saveCurrent()
  }

  /** Pull the next group off the queue: a contiguous run of parallel-flagged
   *  agents (a concurrent wave), or a single non-parallel agent (serial). */
  private nextGroup(): Participant[] {
    const first = this.queue.shift()!
    const group = [first]
    if (first.parallel) {
      while (this.queue.length > 0 && this.queue[0].parallel) group.push(this.queue.shift()!)
    }
    return group
  }

  /** The concurrency lane an agent runs on. Same-lane agents are serialized;
   *  different lanes run concurrently. All local models share one lane because
   *  llama-server runs --parallel 1; each cloud provider is its own lane. */
  private laneOf(p: Participant): string {
    const provider = p.persona.model ? p.persona.model.split("/")[0] : "local"
    return provider === "local" ? "local" : `cloud:${provider}`
  }

  /** Run a group concurrently. All members see the same pre-wave transcript.
   *  Per-lane serialization keeps local agents one-at-a-time; cloud agents on
   *  distinct endpoints run truly in parallel. Results come back in group order. */
  private async runWave(group: Participant[]): Promise<Array<RunOutput | null>> {
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
          laneTail.set(lane, result.catch(() => {}))
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
  private async executeAgent(
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
        await this.localLock.acquire()
        lockAcquired = true
      }
      const result = mode === "prompt"
        ? await target.run(context.text, context.images)
        : await target.followUp(context.text, context.images)
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
      const stopReason: "aborted" | "error" | undefined = this.aborted ? "aborted" : result.stopReason
      const after = this.remote ? undefined : await snapshot(this.workspaceDir)

      // Broadcast context usage and session stats after the turn — piggyback on status event.
      // The idle status already fires from Participant.run() finally block;
      // this second broadcast adds contextUsage and sessionStats to the payload.
      const usage = target.getContextUsage?.()
      const stats = target.getSessionStats?.()
      if (usage || stats) {
        const payload: Record<string, unknown> = { id: target.persona.id, status: "idle" }
        if (usage) payload.contextUsage = usage
        if (stats) payload.sessionStats = stats
        this.emit("status", payload)
      }

      return {
        target,
        reply: result.text,
        activity: result.activity,
        reasoning: result.reasoning,
        // A question from an interrupted/failed turn isn't a real pause request
        // — the turn didn't end the normal way a pause is supposed to.
        question: stopReason ? undefined : result.question,
        questionOptions: stopReason ? undefined : result.questionOptions,
        stopReason,
        errorMessage: result.errorMessage,
        receipt: before && after
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
      if (lockAcquired) this.localLock?.release()
      this.running.delete(target)
    }
  }

  /** Run one agent via prompt. Thin wrapper around executeAgent. */
  private runAgent(
    target: Participant,
    context: { text: string; images?: string[] },
  ): Promise<RunOutput | null> {
    return this.executeAgent(target, context, "prompt")
  }

  /** Follow-up one agent via session.followUp(). Thin wrapper around executeAgent.
   *  Used for self-chaining (ask_user resume) — guaranteed to be the next thing
   *  the agent processes. */
  private followUpAgent(
    target: Participant,
    context: { text: string; images?: string[] },
  ): Promise<RunOutput | null> {
    return this.executeAgent(target, context, "followUp")
  }

  /** Handle slash commands. Returns true if handled. */
  private async handleSlashCommand(text: string): Promise<boolean> {
    if (!text.startsWith("/")) return false
    const [cmd, ...args] = text.split(/\s+/)
    const rawTarget = args[0]
    const id = rawTarget?.replace(/^@/, "").toLowerCase()

    switch (cmd) {
      case "/kick":
        if (id && this.registry.has(id)) {
          this.registry.kick(id)
          this.notice(`Kicked @${id}.`)
        } else this.notice(`/kick: unknown participant "${rawTarget ?? ""}".`, "error")
        return true
      case "/deactivate":
        if (id && this.registry.has(id)) {
          this.registry.setActive(id, false)
          this.notice(`Deactivated @${id}.`)
        } else this.notice(`/deactivate: unknown participant "${rawTarget ?? ""}".`, "error")
        return true
      case "/activate":
        if (id && this.registry.has(id)) {
          this.registry.setActive(id, true)
          this.notice(`Activated @${id}.`)
        } else this.notice(`/activate: unknown participant "${rawTarget ?? ""}".`, "error")
        return true
      case "/compact": {
        if (!id) {
          this.notice(`/compact: usage — /compact @agent`, "error")
          return true
        }
        const target = this.registry.get(id)
        if (!target) {
          this.notice(`/compact: unknown participant "${rawTarget ?? ""}".`, "error")
          return true
        }
        // isGenerating, not isBusy: an ask_user pause is a quiescent room —
        // compacting there is safe and it's exactly when you want the headroom.
        if (this.isGenerating()) {
          this.notice(`/compact: agents are generating — wait or press Stop first.`, "error")
          return true
        }
        this.notice(`Compacting @${id}'s context…`)
        try {
          const result = await target.compact()
          this.notice(`@${id} compacted: ${result.tokensBefore} tokens before → summary generated.`)
        } catch (err) {
          this.notice(`/compact @${id} failed: ${err instanceof Error ? err.message : String(err)}`, "error")
        }
        return true
      }
      case "/help":
        this.notice(
          "Commands: /help, /kick @agent, /activate @agent, /deactivate @agent, " +
          "/compact @agent, /model @agent provider/id, /thinking [level|@agent level], " +
          "/stats [@agent], /chaining on|off, /default @agent|none, /fallback @agent|none, " +
          "/provider [list|add <name> <key>|remove <name>]"
        )
        return true
      case "/model": {
        const agentId = args[0]?.replace(/^@/, "").toLowerCase()
        const modelRef = args[1]
        if (!agentId || !modelRef) {
          this.notice("/model: usage — /model @agent provider/id", "error")
          return true
        }
        if (!this.registry.has(agentId)) {
          this.notice(`/model: unknown participant "@${agentId}".`, "error")
          return true
        }
        if (!this.registry.isAllowedModel(modelRef)) {
          this.notice(`/model: "${modelRef}" is not available. Use GET /api/models to list.`, "error")
          return true
        }
        try {
          await this.registry.update(agentId, { model: modelRef })
          this.notice(`@${agentId} model → ${modelRef}`)
        } catch (err) {
          this.notice(`/model @${agentId} failed: ${err instanceof Error ? err.message : String(err)}`, "error")
        }
        return true
      }
      case "/thinking": {
        const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const
        if (args[0]?.startsWith("@")) {
          // Per-agent: /thinking @agent level
          const agentId = args[0].replace(/^@/, "").toLowerCase()
          const level = args[1]
          if (!level || !(LEVELS as readonly string[]).includes(level)) {
            this.notice(`/thinking: usage — /thinking @agent ${LEVELS.join("|")}`, "error")
            return true
          }
          const p = this.registry.get(agentId)
          if (!p) {
            this.notice(`/thinking: unknown participant "@${agentId}".`, "error")
            return true
          }
          const available = p.getAvailableThinkingLevels?.()
          if (available && available.length > 0 && !available.includes(level)) {
            this.notice(`/thinking: "${level}" not available for @${agentId}. Available: ${available.join(", ")}`, "error")
            return true
          }
          try {
            await this.registry.setThinkingLevel(agentId, level as typeof LEVELS[number])
            this.notice(`@${agentId} thinking → ${level}`)
          } catch (err) {
            this.notice(`/thinking @${agentId} failed: ${err instanceof Error ? err.message : String(err)}`, "error")
          }
        } else {
          // Global: /thinking level
          const level = args[0]
          if (!level || !(LEVELS as readonly string[]).includes(level)) {
            this.notice(`/thinking: usage — /thinking ${LEVELS.join("|")}`, "error")
            return true
          }
          config.thinkingLevel = level as typeof LEVELS[number]
          this.notice(`Global thinking → ${level}`)
        }
        return true
      }
      case "/stats": {
        if (id) {
          // Per-agent stats
          const p = this.registry.get(id)
          if (!p) {
            this.notice(`/stats: unknown participant "@${id}".`, "error")
            return true
          }
          const stats = p.getSessionStats?.()
          const ctx = p.getContextUsage?.()
          const parts: string[] = [`@${id}:`]
          if (stats) {
            const { input, output, cacheRead, total } = stats.tokens
            const cachePct = total > 0 ? Math.round((cacheRead / total) * 100) : 0
            parts.push(`${input}i / ${output}o · cache ${cachePct}% · ${stats.toolCalls} tools · ${stats.userMessages + stats.assistantMessages} msgs`)
          }
          if (ctx) {
            parts.push(`context: ${ctx.tokens ?? "?"}/${ctx.contextWindow} (${ctx.percent ?? "?"}%)`)
          }
          if (!stats && !ctx) parts.push("no stats yet")
          this.notice(parts.join(" · "))
        } else {
          // All agents summary
          for (const item of this.registry.roster()) {
            const p = this.registry.get(item.id)
            if (!p) continue
            const stats = p.getSessionStats?.()
            const ctx = p.getContextUsage?.()
            const parts: string[] = [`@${item.id}`]
            if (stats) {
              const { input, output, cacheRead, total } = stats.tokens
              const cachePct = total > 0 ? Math.round((cacheRead / total) * 100) : 0
              parts.push(`${input}i / ${output}o · cache ${cachePct}% · ${stats.toolCalls} tools`)
            }
            if (ctx) {
              parts.push(`ctx ${ctx.percent ?? "?"}%`)
            }
            if (!stats && !ctx) parts.push("no stats yet")
            this.notice(parts.join(" · "))
          }
        }
        return true
      }
      case "/chaining": {
        const val = args[0]?.toLowerCase()
        if (val === "on") {
          this.setChaining(true)
          this.notice("Chaining → on")
        } else if (val === "off") {
          this.setChaining(false)
          this.notice("Chaining → off")
        } else {
          this.notice("/chaining: usage — /chaining on|off", "error")
        }
        return true
      }
      case "/default": {
        if (!rawTarget || rawTarget.toLowerCase() === "none") {
          this.setDefaultAgent(null)
          this.notice("Default agent → none (first active)")
        } else {
          const agentId = rawTarget.replace(/^@/, "").toLowerCase()
          try {
            this.setDefaultAgent(agentId)
            this.notice(`Default agent → @${agentId}`)
          } catch (err) {
            this.notice(`/default: ${err instanceof Error ? err.message : String(err)}`, "error")
          }
        }
        return true
      }
      case "/fallback": {
        if (!rawTarget || rawTarget.toLowerCase() === "none") {
          this.setFallbackAgent(null)
          this.notice("Fallback routing → disabled")
        } else {
          const agentId = rawTarget.replace(/^@/, "").toLowerCase()
          try {
            this.setFallbackAgent(agentId)
            this.notice(`Fallback routing → @${agentId}`)
          } catch (err) {
            this.notice(`/fallback: ${err instanceof Error ? err.message : String(err)}`, "error")
          }
        }
        return true
      }
      case "/provider": {
        const subCmd = args[0]?.toLowerCase()
        if (subCmd === "list" || !subCmd) {
          // List providers
          const providers = this.registry.getProviderList()
          const lines = providers.map((p) =>
            `${p.configured ? "✓" : "○"} ${p.displayName} (${p.models} models)`,
          )
          this.notice(`Providers:\n${lines.join("\n")}`)
        } else if (subCmd === "add") {
          const providerName = args[1]
          const apiKey = args[2]
          if (!providerName || !apiKey) {
            this.notice("/provider add: usage — /provider add <name> <api_key>", "error")
          } else {
            try {
              this.registry.setProviderKey(providerName, apiKey)
              this.notice(`Provider "${providerName}" configured. Models should now be available.`)
            } catch (err) {
              this.notice(`/provider add failed: ${err instanceof Error ? err.message : String(err)}`, "error")
            }
          }
        } else if (subCmd === "remove") {
          const providerName = args[1]
          if (!providerName) {
            this.notice("/provider remove: usage — /provider remove <name>", "error")
          } else {
            try {
              this.registry.removeProviderKey(providerName)
              this.notice(`Provider "${providerName}" removed.`)
            } catch (err) {
              this.notice(`/provider remove failed: ${err instanceof Error ? err.message : String(err)}`, "error")
            }
          }
        } else {
          this.notice(`/provider: unknown sub-command "${subCmd}". Use: list, add <name> <key>, remove <name>`, "error")
        }
        return true
      }
      default:
        this.notice(`Unknown command "${cmd}".`, "error")
        return true
    }
  }

  /** Shared drain loop — replaces the 4 duplicated inline loops.
   *  Returns true if the pipeline was paused by an ask_user (caller should return).
   *  Handles parallel-wave questions correctly: posts ALL results from the wave
   *  before pausing on the first question, so no agent output is silently dropped. */
  /** Decide who runs next from `fromId`'s turn and append them onto `target`.
   *  Honors the chain-hop budget; when no handoff was registered and a fallback
   *  agent is configured, routes there with a nudge to pick the next agent.
   *  Shared by the main drain loop and the ask-user resume path so routing is
   *  identical in both — the resume path previously pushed @mentions onto a
   *  queue it then discarded, silently dropping a handoff made right after
   *  answering a question. */
  private async proposeChain(fromId: string, target: Participant[], opts?: { prepend?: boolean }): Promise<Participant[]> {
    const mentioned = this.resolveHandoff(fromId)
    if (mentioned.length > 0) {
      // De-dupe against the pending queue: if e.g. scout AND builder both hand
      // off to @planner in the same pass, enqueue the planner once instead of
      // running it back-to-back (the loop kept returning to it 2-3× in a row).
      const next = mentioned.filter((p) => !target.includes(p))
      if (next.length === 0) return []
      if (this.routingMode !== "auto") {
        // semi/manual: hand these back for human approval. Don't enqueue or spend
        // hop budget yet — that happens when the human approves.
        return next
      }
      if (this.chainBudget < this.maxChainHops) {
        this.chainBudget += next.length
        // prepend: a fresh mention outranks work frozen before a pause — the
        // ask_user resume path uses this so recent intent runs first.
        if (opts?.prepend) target.unshift(...next)
        else target.push(...next)
        this.emit("turn", { phase: "chain", from: fromId, targets: next.map((t) => t.persona.id) })
      } else {
        this.notice(`Chain budget exhausted (${this.maxChainHops} hops) — stopping.`, "info")
      }
      return []
    }
    // No handoff registered. In a running goal-eval room, give the agent ONE
    // closed-menu re-prompt before letting its turn die: small models often
    // forget the handoff call, and a menu of the agent's real options (same
    // pick-from-a-list principle as the handoff enum itself) is recoverable,
    // where a silent turn end just burns a goal iteration. One-shot per agent
    // per eval iteration (noHandoffMenuUsed); auto mode only — re-running the
    // same agent is not a routable proposal for a human to approve. The
    // evaluator is exempt: its goal_eval prompt already structures its ending
    // (GOAL_MET or dispatch), and runGoalEval handles it.
    if (
      this.routingMode === "auto" &&
      this.goalMode === "eval" &&
      this.goalText !== null &&
      this.goalStatus === "running" &&
      fromId !== this.goalEvaluator &&
      !this.noHandoffMenuUsed.has(fromId) &&
      this.chainBudget < this.maxChainHops
    ) {
      const from = this.registry.get(fromId)
      if (from && from.active && !target.includes(from)) {
        this.noHandoffMenuUsed.add(fromId)
        this.chainBudget += 1
        this.notice(`No handoff detected — one-shot menu to @${fromId}`, "info")
        await from.sendCustomMessage(
          {
            customType: "no_handoff_menu",
            content: this.buildNoHandoffMenu(fromId),
            display: false,
          },
          { deliverAs: "nextTurn" },
        )
        if (opts?.prepend) target.unshift(from)
        else target.push(from)
        this.emit("turn", { phase: "chain", from: fromId, targets: [fromId] })
        return []
      }
    }
    if (this.chainBudget < this.maxChainHops) {
      let routedTo: Participant | null = null
      let viaPlan = false

      // Plan-aware routing: consult the plan THIS room has adopted before
      // falling back to the generic fallback agent. If the next incomplete step
      // has an [agent] owner prefix and that agent is available, route there
      // instead. Scoped to activePlanId — a room that hasn't worked a plan
      // routes by none, so no stale plan in the shared graveyard can hijack a
      // turn (the planner↔tester incident, 2026-07-09).
      if (this.planAwareRoutingEnabled && this.activePlanId) {
        const plan = await findPlanById(this.plansDir(), this.activePlanId)
        const ownerId = nextStepOwner(plan)
        if (ownerId && ownerId !== fromId) {
          const owner = this.registry.get(ownerId)
          if (owner && owner.active && !target.includes(owner)) {
            routedTo = owner
            viaPlan = true
          }
        }
      }

      if (!routedTo && this.fallbackAgentId && fromId !== this.fallbackAgentId) {
        const fb = this.registry.get(this.fallbackAgentId)
        if (fb && fb.active && !target.includes(fb)) {
          routedTo = fb
        }
      }

      if (routedTo) {
        this.chainBudget += 1
        target.push(routedTo)
        this.emit("turn", { phase: "chain", from: fromId, targets: [routedTo.persona.id] })
        if (viaPlan) {
          this.notice(`Plan step routing — no handoff detected, next step owned by @${routedTo.persona.id}`, "info")
          // Inject routing context so the owner knows why it's being called.
          await routedTo.sendCustomMessage(
            {
              customType: "plan_step_routing",
              content: `(Plan-aware routing: @${fromId} finished without a handoff. The active plan's next incomplete step is assigned to you — check the plan and continue it.)`,
              display: false,
            },
            { deliverAs: "nextTurn" },
          )
        } else {
          this.notice(`No handoff detected — routing to @${routedTo.persona.id}`, "info")
          // Inject routing context so the fallback agent knows why it's being called.
          await routedTo.sendCustomMessage(
            {
              customType: "routing_fallback",
              content: `(Routing fallback: @${fromId} finished without handing off. Based on the conversation state, decide who should go next — call handoff(to: "...") with their id. If the work is complete, just say so — don't call handoff.)`,
              display: false,
            },
            { deliverAs: "nextTurn" },
          )
        }
      }
    }
    return []
  }

  /** The plans directory THIS room's plan-aware routing consults. Rooms on
   *  the default workspace keep the global config.plansDir (honors the
   *  PIPELINE_PLANS_DIR override and the hermetic test sentinel); a room with
   *  its own workspaceDir gets `<workspace>/.pi/plans` instead. Without this
   *  scoping, every secondary room read the MAIN workspace's active plan and
   *  routed by it — observed live: a sandbox room ping-ponged planner↔tester
   *  ~11 turns because the main repo's active plan had a [tester] step. */
  private plansDir(): string {
    return this.workspaceDir === config.workspaceDir
      ? config.plansDir
      : resolve(this.workspaceDir, ".pi", "plans")
  }

  /** The one-shot closed menu injected when a goal-eval agent ends its turn
   *  without a handoff. Generated from live state so it never offers a dead
   *  option: real roster ids for handoff, ask_orchestrator only in sub-rooms
   *  (parent link present), ask_user otherwise. Closed list on purpose — a
   *  small model picks reliably from a menu where it fails an open
   *  instruction. */
  private buildNoHandoffMenu(fromId: string): string {
    const targets = this.registry.activeIds().filter((id) => id !== fromId)
    const lines = [
      "(No handoff detected — your turn ended without passing the work on, and the goal is still running. Pick EXACTLY ONE:",
    ]
    if (targets.length > 0) {
      lines.push(` • call handoff(to: "<id>") — pass the turn. Valid ids: ${targets.join(", ")}`)
    }
    lines.push(
      this.registry.hasParentLink
        ? ` • call ask_orchestrator({ question: "..." }) — you are blocked on something outside this room`
        : ` • call ask_user({ question: "..." }) — you are blocked on something only the user can provide`,
    )
    lines.push(" • reply DONE — you believe the goal is complete; the evaluator will verify")
    lines.push("Do nothing else: no other tools, no long explanation.)")
    return lines.join("\n")
  }

  /** Broadcast the current routing proposal so the UI can render the approval card. */
  private emitRoutingProposed(): void {
    if (!this.pendingRoute) return
    this.emit("routing", {
      type: "proposed",
      proposals: this.pendingRoute.proposals.map((p) => ({
        from: p.fromId,
        target: p.target.persona.id,
        targetName: p.target.persona.name,
      })),
    })
  }

  /** Serializable snapshot of a pending routing proposal (for state bootstrap),
   *  or null when nothing is awaiting approval. */
  getPendingRoute(): { proposals: Array<{ from: string; target: string; targetName: string }> } | null {
    if (!this.pendingRoute) return null
    return {
      proposals: this.pendingRoute.proposals.map((p) => ({
        from: p.fromId,
        target: p.target.persona.id,
        targetName: p.target.persona.name,
      })),
    }
  }

  /** Apply the human's decision on a pending routing proposal (semi/manual).
   *  Serialized onto the room's turn chain so it can't race a running turn. */
  resolveRoute(decision: RouteDecision): void {
    this.chain = this.chain.then(() => this.processRouteDecision(decision)).catch((err) => {
      this.notice(`Room error: ${err instanceof Error ? err.message : String(err)}`, "error")
    })
  }

  private async processRouteDecision(decision: RouteDecision): Promise<void> {
    const pr = this.pendingRoute
    if (!pr) return // nothing pending (already resolved, or raced an abort)
    this.pendingRoute = null
    this.aborted = false

    let toRun: Participant[] = []
    if (decision.action === "approve") {
      toRun = pr.proposals.map((p) => p.target)
    } else if (decision.action === "redirect") {
      toRun = (decision.targetIds ?? [])
        .map((id) => this.registry.get(id))
        .filter((p): p is Participant => !!p && p.active)
    }
    // "drop" → toRun stays empty: continue with whatever work was already held.

    const fresh = toRun.filter((p) => !pr.heldQueue.includes(p))
    if (fresh.length > 0) {
      this.chainBudget += fresh.length
      pr.heldQueue.push(...fresh)
      this.emit("turn", { phase: "chain", from: null, targets: fresh.map((t) => t.persona.id) })
    }
    this.emit("routing", { type: "resolved", action: decision.action, targets: fresh.map((t) => t.persona.id) })

    this.queue = pr.heldQueue
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

  private async drainQueue(): Promise<boolean> {
    while (this.queue.length > 0 && !this.aborted) {
      const group = this.nextGroup()
      if (group.length > 1) {
        this.notice(`running ${group.length} in parallel: ${group.map((g) => `@${g.persona.id}`).join(" ")}`)
        this.emit("turn", { phase: "parallel", targets: group.map((g) => g.persona.id) })
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
        const marker = out.stopReason === "aborted"
          ? " _(interrupted — partial)_"
          : out.stopReason === "error"
            ? ` _(failed — partial${out.errorMessage ? `: ${out.errorMessage}` : ""})_`
            : ""
        this.post(out.target.persona.id, out.target.persona.name, (out.reply || "(no response)") + marker, out.activity, out.reasoning, undefined, out.question, out.questionOptions)
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
          const proposed = await this.proposeChain(out.target.persona.id, this.queue)
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
            { customType: "work_receipt", content: formatReceipt(out.receipt), display: false },
            { deliverAs: "nextTurn" },
          )
        }
      }

      // If we encountered a question in this wave, pause now (after all wave results are posted).
      if (paused) {
        this.pendingQuestion = { askerId: pauseAskerId!, heldQueue: [...this.queue] }
        this.queue = []
        this.emit("turn", { phase: "pause", askerId: pauseAskerId!, question: pauseQuestion!, options: pauseOptions })
        return true
      }

      // semi/manual: if any handoffs were proposed this wave, pause for approval
      // before running them. The held queue resumes after the human decides.
      if (waveProposals.length > 0) {
        this.pendingRoute = { proposals: waveProposals, heldQueue: [...this.queue] }
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
    const had = this.queue.length > 0 || this.running.size > 0 || this.pendingQuestion !== null || this.pendingRoute !== null
    this.queue = []
    this.pendingQuestion = null
    this.pendingRoute = null
    await Promise.all([...this.running].map((p) => p.abort()))
    return had
  }
}
