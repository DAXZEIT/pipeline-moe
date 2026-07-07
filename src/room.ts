// The Room: shared transcript + serial turn queue + @mention routing + work
// receipts. One room per process. All model work is serialised here, which
// also matches llama-server running with --parallel 1.

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
import { REPEAT_THRESHOLD, SIMILARITY_FLOOR, textSimilarity, LOOKBACK_WINDOW, checkToolLoop, TOOL_REPEAT_THRESHOLD } from "./circuit-breaker.js"
import { goalEvalPrompt } from "./personas.js"
import type {
  Conversation,
  ConversationMeta,
  Persona,
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
}

function newConvId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export class Room {
  private transcript: TranscriptEntry[] = []
  private chain: Promise<void> = Promise.resolve()
  /** Agents currently mid-turn. >1 when a parallel wave is running. */
  private running = new Set<Participant>()
  /** Id of the first agent that started the current turn. Used for UI targeting (steer). */
  private runningAgentId: string | null = null
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
  /** Agent whose circuit breaker tripped — used for fallback recovery routing. null = no breaker event. */
  private circuitBreakerAgentId: string | null = null
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
    /** Whether the repetition/tool-loop circuit breaker is active. Defaults to
     *  config.circuitBreaker (ON). Disabled for cloud models that legitimately repeat.
     *  Mutable — can be toggled per-room via the Settings panel. */
    private circuitBreakerEnabled: boolean = config.circuitBreaker,
    /** Directory this room is scoped to: where file tools are confined, bash runs,
     *  work receipts snapshot, and the workspace listing looks. Defaults to the
     *  pipeline workspace. */
    private readonly workspaceDir: string = config.workspaceDir,
    /** True when the workspace is a remote (sshfs) mount. Walking the whole
     *  remote tree per turn would stall every action for ~a minute over the
     *  network, so work receipts and the live workspace listing are skipped
     *  for remote rooms. */
    private readonly remote: boolean = false,
  ) {}

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
    // In eval mode the eval loop is the sole router: the evaluator is invoked
    // deliberately after every natural drain. Leaving generic fallback routing
    // active would re-invoke the evaluator (when it is also the fallback agent)
    // with a misleading "routing fallback" context — doubling invocations and
    // draining the iteration budget. Suppress fallback for the whole goal run
    // (initial drain + eval loop); runGoalEval's finally restores it.
    if (this.goalMode === "eval") {
      this.goalEvalSavedFallback = this.fallbackAgentId
      this.fallbackAgentId = null
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

  getMaxChainHops(): number {
    return this.maxChainHops
  }

  setMaxChainHops(n: number): void {
    this.maxChainHops = Math.max(1, Math.min(100, Math.round(n)))
    this.broadcastSettings()
    void this.saveCurrent()
  }

  // ── Circuit breaker toggle ──────────────────────────────────────────────────

  getCircuitBreaker(): boolean {
    return this.circuitBreakerEnabled
  }

  setCircuitBreaker(enabled: boolean): void {
    this.circuitBreakerEnabled = enabled
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
      maxChainHops: this.maxChainHops,
      circuitBreaker: this.circuitBreakerEnabled,
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
      circuitBreaker: this.circuitBreakerEnabled,
      defaultThinkingLevel: this.defaultThinkingLevel,
      allowCloud: this.allowCloud,
      compactionReserveTokens: this.compactionReserveTokens,
      personas: this.registry.personaStates(),
      transcript: this.transcript,
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

  /** True while an agent is running or queued — editing a roster member's
   *  session (which disposes+recreates it) is unsafe during this window. */
  isBusy(): boolean {
    return this.running.size > 0 || this.queue.length > 0 || this.pendingQuestion !== null || this.pendingRoute !== null
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
    // Back-compat: older saves don't have these fields — fall back to config defaults.
    this.circuitBreakerEnabled = conv.circuitBreaker ?? config.circuitBreaker
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
    this.broadcastSettings()
    this.emit("transcript", this.transcript)
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
    }
    this.transcript.push(entry)

    // Circuit breaker — only for agents, not user
    if (this.circuitBreakerEnabled && author !== "user" && this.checkRepetition(author, text)) {
      this.aborted = true
      this.circuitBreakerAgentId = author
      const msg = `Circuit breaker: @${authorName} repeated similar output ${REPEAT_THRESHOLD} times — stopping.`
      this.notice(msg, "error")
      this.emit("circuit_breaker", { agentId: author, agentName: authorName, count: REPEAT_THRESHOLD })
    }

    // Tool-call loop breaker — detect repeated identical tool calls
    if (this.circuitBreakerEnabled && author !== "user" && activity && activity.length > 0 && !this.aborted) {
      const result = checkToolLoop(this.transcript, author, activity)
      if (result.tripped) {
        this.aborted = true
        this.circuitBreakerAgentId = author
        const sig = result.signature ?? "unknown"
        const msg = `Circuit breaker: @${authorName} repeated tool call "${sig}" ${result.count} times — stopping.`
        this.notice(msg, "error")
        this.emit("circuit_breaker", { agentId: author, agentName: authorName, count: result.count, type: "tool_loop", signature: sig })
      }
    }

    this.emit("message", entry)
    return entry
  }

  /**
   * Check if the current text is a repetition of recent messages from the same author.
   * Scans the last LOOKBACK_WINDOW messages from that author; if ≥ REPEAT_THRESHOLD
   * have similarity ≥ SIMILARITY_FLOOR, returns true.
   */
  private checkRepetition(author: string, text: string): boolean {
    const recent: string[] = []
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      const entry = this.transcript[i]
      if (entry.author !== author) continue
      recent.push(entry.text)
      if (recent.length >= LOOKBACK_WINDOW) break
    }

    let similarCount = 0
    for (const prev of recent) {
      if (textSimilarity(text, prev) >= SIMILARITY_FLOOR) {
        similarCount++
      }
    }

    // similarCount includes the current message's match against itself,
    // so we need ≥ REPEAT_THRESHOLD total (the current message + REPEAT_THRESHOLD-1 prior)
    return similarCount >= REPEAT_THRESHOLD
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
        this.goalStatus = "completed"
        this.emit("room", { type: "goal-completed", goalText: this.goalText })
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
   *    - @-mentions an agent → that agent runs (via drainQueue chaining), then
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
      this.goalStatus = "completed"
      this.emit("room", { type: "goal-completed", goalText: this.goalText })
      this.fallbackAgentId = this.goalEvalSavedFallback
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
          this.goalStatus = "cancelled"
          this.emit("room", { type: "goal-cancelled", goalText: this.goalText })
          this.notice(`Goal cancelled on iteration ${this.goalIteration}.`, "info")
          return
        }
        this.goalIteration++

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

        // Run the evaluator and any agents it dispatches via @mention chaining.
        this.queue = [evaluator]
        this.aborted = false
        this.circuitBreakerAgentId = null
        this.chainBudget = 0
        this.runningAgentId = evaluator.persona.id
        this.emit("turn", { phase: "chain", from: null, targets: [evaluator.persona.id] })
        await this.drainQueue()

        // Cancelled mid-drain — stop now, before reinterpreting the drain as a
        // completion or circuit-breaker failure.
        if (this.goalCancelled) {
          this.goalStatus = "cancelled"
          this.emit("room", { type: "goal-cancelled", goalText: this.goalText })
          this.notice(`Goal cancelled on iteration ${this.goalIteration}.`, "info")
          return
        }

        // Did the evaluator declare the goal met in its most recent message?
        if (this.evaluatorDeclaredGoalMet(evaluator.persona.id)) {
          this.goalStatus = "completed"
          this.emit("room", { type: "goal-completed", goalText: this.goalText })
          return
        }

        // Circuit breaker tripped during this eval pass — give up.
        if (this.aborted) {
          this.goalStatus = "failed"
          this.emit("room", { type: "goal-failed", goalText: this.goalText, reason: "aborted" })
          this.notice(`Goal eval aborted on iteration ${this.goalIteration} (circuit breaker).`, "error")
          return
        }
      }

      // Iteration budget exhausted without GOAL_MET.
      this.goalStatus = "failed"
      this.emit("room", { type: "goal-failed", goalText: this.goalText, reason: "max-iterations" })
      this.notice(`Goal eval exhausted after ${this.maxGoalIterations} iterations without GOAL_MET.`, "error")
    } finally {
      this.fallbackAgentId = this.goalEvalSavedFallback
      this.runningAgentId = null
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

  /** Resolve @mentions emitted BY an agent. No @all (human-only), never the
   *  speaker itself, active participants only. Scans the full reply text.
   *  No budget / anti-rebound for now. */
  private resolveAgentMentions(text: string, selfId: string): Participant[] {
    const mentioned = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = MENTION_RE.exec(text)) !== null) mentioned.add(m[1].toLowerCase())
    mentioned.delete("all") // agents cannot fan out to everyone
    mentioned.delete(selfId) // no self-invocation

    const out: Participant[] = []
    for (const id of mentioned) {
      const p = this.registry.get(id)
      if (p && p.active) out.push(p)
    }
    return out
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
    const userEntry = [...unseen].reverse().find((e) => e.author === "user")
    const images = userEntry?.images

    return {
      text: `${lines}\n\n---\nYou are ${p.persona.name}. Respond to the conversation above from your perspective now.`,
      images,
    }
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

      this.post("user", "You", trimmed, undefined, undefined, images)
      this.emit("turn", { phase: "resume", askerId: pq.askerId })
      this.aborted = false

      // Force-route to the agent that asked the question.
      const asker = this.registry.get(pq.askerId)
      if (!asker || !asker.active) {
        this.notice(`@${pq.askerId} is no longer active — resuming held queue.`, "info")
        this.queue = pq.heldQueue
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
      if (result && !this.aborted) {
        // Post with question field if the asker asked another question.
        this.post(asker.persona.id, asker.persona.name, result.reply || "(no response)", result.activity, result.reasoning, undefined, result.question)
        if (receiptHasChanges(result.receipt)) this.emit("receipt", result.receipt)
        asker.cursor = this.transcript.length

        // If the asker asked ANOTHER question, re-pause.
        if (result.question) {
          this.pendingQuestion = { askerId: asker.persona.id, heldQueue: pq.heldQueue }
          this.emit("turn", { phase: "pause", askerId: asker.persona.id, question: result.question })
          await this.emitWorkspace()
          await this.saveCurrent()
          return
        }

        // Chain from the asker's reply onto the held queue (it resumes draining
        // below). Routes identically to the main drain loop — a handoff made right
        // after answering a question now continues instead of being dropped.
        if (this.chaining) {
          const proposed = await this.proposeChain(asker.persona.id, result.reply, pq.heldQueue)
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

      // Restore the held queue and continue draining.
      this.queue = pq.heldQueue
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
    this.circuitBreakerAgentId = null
    this.runningAgentId = initial[0]?.persona.id ?? null
    this.emit("turn", { phase: "start", targets: initial.map((t) => t.persona.id), agentId: this.runningAgentId })

    // Drain the queue — shared method handles questions, chaining, and parallel waves.
    const paused = await this.drainQueue()
    if (paused) {
      await this.emitWorkspace()
      await this.saveCurrent()
      return
    }

    // Circuit breaker recovery: if the breaker tripped and a fallback agent
    // is configured (and is not the looping agent), route to it instead of
    // silently dying. Loop up to MAX_RECOVERY_DEPTH times to handle cases where
    // the looping agent re-enters after the fallback hands back to it.
    const MAX_RECOVERY_DEPTH = 2
    let recoveryDepth = 0
    while (
      this.aborted &&
      this.circuitBreakerAgentId &&
      this.fallbackAgentId &&
      this.circuitBreakerAgentId !== this.fallbackAgentId &&
      recoveryDepth < MAX_RECOVERY_DEPTH
    ) {
      recoveryDepth++
      const fb = this.registry.get(this.fallbackAgentId)
      if (!fb || !fb.active) break
      const depthNote = MAX_RECOVERY_DEPTH > 1 ? ` (recovery ${recoveryDepth}/${MAX_RECOVERY_DEPTH})` : ""
      this.notice(`Circuit breaker tripped on @${this.circuitBreakerAgentId} — routing to @${this.fallbackAgentId} for recovery${depthNote}.`, "info")
      this.emit("turn", { phase: "chain", from: this.circuitBreakerAgentId, targets: [this.fallbackAgentId] })
      // Inject recovery context so the fallback agent knows why it's being called.
      await fb.sendCustomMessage(
        {
          customType: "circuit_breaker_recovery",
          content: `(Circuit breaker tripped on @${this.circuitBreakerAgentId} — it looped. Take over: assess the situation, assign work to another agent by @-mentioning them, or declare the work done if appropriate. Do not attempt the same action that caused the loop.)`,
          display: false,
        },
        { deliverAs: "nextTurn" },
      )
      // Reset abort state and resume draining with the fallback agent.
      this.aborted = false
      this.circuitBreakerAgentId = null
      this.queue = [fb]
      this.runningAgentId = fb.persona.id
      const recovered = await this.drainQueue()
      if (recovered) {
        await this.emitWorkspace()
        await this.saveCurrent()
        return
      }
      // If drainQueue exited without pause, loop to check if another circuit breaker fired.
    }

    // Goal terminated by abort without recovery. Set before endTurn so its
    // completion guard doesn't overwrite the status. A user/planner cancel
    // (goalCancelled) resolves to "cancelled"; a circuit-breaker abort to
    // "failed".
    if (this.aborted && this.goalText !== null && this.goalStatus === "running") {
      if (this.goalCancelled) {
        this.goalStatus = "cancelled"
        this.emit("room", { type: "goal-cancelled", goalText: this.goalText })
      } else {
        this.goalStatus = "failed"
        this.emit("room", { type: "goal-failed", goalText: this.goalText })
      }
      // Aborting during the INITIAL drain of an eval-mode goal means runGoalEval
      // never ran, so its finally never restored the fallback agent that
      // submitGoal suppressed. Restore it here so the room isn't left with
      // fallback routing silently disabled.
      if (this.goalMode === "eval") this.fallbackAgentId = this.goalEvalSavedFallback
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
      if (this.aborted) return null
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
        question: result.question,
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
        if (this.isBusy()) {
          this.notice(`/compact: wait until the current turn finishes.`, "error")
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
  /** Decide who runs next from `fromId`'s reply and append them onto `target`.
   *  Honors the chain-hop budget; when no @mention is found and a fallback agent
   *  is configured, routes there with a nudge to pick the next agent. Shared by
   *  the main drain loop and the ask-user resume path so routing is identical in
   *  both — the resume path previously pushed @mentions onto a queue it then
   *  discarded, silently dropping a handoff made right after answering a question. */
  private async proposeChain(fromId: string, reply: string, target: Participant[]): Promise<Participant[]> {
    const mentioned = this.resolveAgentMentions(reply, fromId)
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
        target.push(...next)
        this.emit("turn", { phase: "chain", from: fromId, targets: next.map((t) => t.persona.id) })
      } else {
        this.notice(`Chain budget exhausted (${this.maxChainHops} hops) — stopping.`, "info")
      }
      return []
    }
    if (
      this.fallbackAgentId &&
      fromId !== this.fallbackAgentId &&
      this.chainBudget < this.maxChainHops
    ) {
      const fb = this.registry.get(this.fallbackAgentId)
      if (fb && fb.active && !target.includes(fb)) {
        this.chainBudget += 1
        target.push(fb)
        this.notice(`No handoff detected — routing to @${this.fallbackAgentId}`, "info")
        this.emit("turn", { phase: "chain", from: fromId, targets: [this.fallbackAgentId] })
        // Inject routing context so the fallback agent knows why it's being called.
        await fb.sendCustomMessage(
          {
            customType: "routing_fallback",
            content: `(Routing fallback: @${fromId} finished without handing off. Based on the conversation state, decide who should go next — @-mention them in your reply. If the work is complete, say so without mentioning anyone.)`,
            display: false,
          },
          { deliverAs: "nextTurn" },
        )
      }
    }
    return []
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
      const waveProposals: RouteProposal[] = []

      for (const out of results) {
        if (!out || this.aborted) continue

        if (out.question && !paused) {
          // First question in this wave — remember it, but don't return yet.
          paused = true
          pauseAskerId = out.target.persona.id
          pauseQuestion = out.question
        }

        // Post the result (with question field if applicable).
        this.post(out.target.persona.id, out.target.persona.name, out.reply || "(no response)", out.activity, out.reasoning, undefined, out.question)
        if (receiptHasChanges(out.receipt)) this.emit("receipt", out.receipt)
        out.target.cursor = this.transcript.length

        // Chain from this reply (even if it had a question — the question is
        // posted as part of the message, so @mentions in the text still chain).
        if (this.chaining) {
          const proposed = await this.proposeChain(out.target.persona.id, out.reply, this.queue)
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
        this.emit("turn", { phase: "pause", askerId: pauseAskerId!, question: pauseQuestion! })
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
