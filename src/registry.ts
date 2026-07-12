// The participant registry: the live roster of agents. Create / activate /
// deactivate / kick all happen here. Emits a "roster" SSE event on any change.

import { rmSync } from "node:fs"
import { resolve } from "node:path"
import { config } from "./config.js"
import { checkHandoffGates } from "./handoff-gates.js"
import { describeRosterBlock, type RosterMemberInfo } from "./roster-awareness.js"
import { isAllowedModel as isAllowedModel_ } from "./model.js"
import { Participant } from "./participant.js"
import { SeatRuntime, type SeatDeps } from "./seat-runtime.js"
import { clusterBySeat, seatIdOf, validateSeatModels } from "./seats.js"
import type { ResolvedModel } from "./model.js"
import type { ParentLink, RoomOrchestrator } from "./orchestrator.js"
import type { TaskBoard } from "./task-board.js"
import type { SseHub } from "./sse.js"
import type { GoalVerdictSink, HandoffGate, HandoffSink, Persona, PersonaState } from "./types.js"

export interface RosterItem {
  id: string
  name: string
  color: string
  icon: string
  tools: string[]
  active: boolean
  status: string
  /** Per-agent model "provider/id", or undefined when on the default. */
  model?: string
  /** Per-agent thinking level, or undefined when inheriting from global config. */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  /** Whether this agent receives image attachments. Undefined → true (assumed capable). */
  vision?: boolean
  /** May run concurrently with adjacent parallel-flagged agents. */
  parallel: boolean
  /** Fused seats: resolved seat id when this member shares a context with
   *  others (the UI groups the hats and shows ONE gauge per seat). Absent →
   *  singleton, render as before. */
  seat?: string
  /** Context token usage — populated after each turn. */
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null }
  /** Session stats — populated after each turn. */
  sessionStats?: {
    userMessages: number
    assistantMessages: number
    toolCalls: number
    totalMessages: number
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
    cost: number
  }
}

export class Registry implements HandoffSink, GoalVerdictSink {
  private participants = new Map<string, Participant>()
  /** Fused seats: seat id → the SeatRuntime that OWNS the pi session. Every
   *  participant belongs to exactly one (singleton seats included — one code
   *  path). Lifecycle is refcounted here: a seat's session and its on-disk
   *  dir survive until its LAST hat is kicked (grilling Q7). */
  private seats = new Map<string, SeatRuntime>()
  /** Seats defused by the one-seat-one-modelRef invariant during the last
   *  batch load — their members run as singletons (loud fallback, never a
   *  lying fusion). Recomputed by reset(). */
  private defusedSeats = new Set<string>()
  /** Fired after any roster mutation (create/activate/kick). Used for autosave. */
  onChange: (() => void) | null = null
  /** Room-assigned hook: post a system-authored note to the transcript.
   *  Same idiom as onChange. Carries the 🧠 reasoning-checkpoint traces. */
  onSystemNote: ((text: string) => void) | null = null

  /** HandoffSink capability — participants call this via their sink. */
  postSystemNote(text: string): void {
    this.onSystemNote?.(text)
  }
  /** Per-agent handoff target registered by the `handoff` tool this turn,
   *  keyed by the calling agent's id. Room consumes it once via
   *  takeHandoff() when resolving that agent's reply — per-agent (not a
   *  single slot) so a parallel wave of agents can each register their own
   *  target without clobbering one another. */
  private pendingHandoff = new Map<string, string>()
  /** During a batch roster load (reset()), the full set of ids about to
   *  exist — lets activeIds() see agents that haven't finished constructing
   *  yet. Without this, reset()'s sequential loop means the FIRST persona in
   *  the batch builds its tools while the map is still empty (it's added to
   *  `participants` only after its OWN Participant.create() resolves), so it
   *  would see zero candidates and permanently lose the handoff tool —
   *  discovered live: the first seed persona (e.g. "scout") never got it.
   *  Null outside a batch (single create() calls already see a fully-formed
   *  registry, since every prior agent finished constructing before them). */
  private pendingRosterIds: Set<string> | null = null
  /** Full states of the batch being loaded by reset() — describeRoster()
   *  reads these while the participants map is still filling, for the same
   *  reason pendingRosterIds exists: the FIRST persona in a batch builds its
   *  system prompt against an otherwise-empty roster. Null outside a batch. */
  private pendingRosterStates: import("./types.js").PersonaState[] | null = null

  /** HandoffSink: ids of currently active participants — used by the
   *  `handoff` tool to build its enum (at construction) and to hard-validate
   *  the target against the live roster (at execution). */
  activeIds(): string[] {
    const live = this.activeParticipants().map((p) => p.persona.id)
    if (!this.pendingRosterIds) return live
    return [...new Set([...live, ...this.pendingRosterIds])]
  }

  /** Whether this registry belongs to a spawned sub-room (its participants
   *  carry the ask_orchestrator escalation tool). Used by Room to offer the
   *  right "I'm blocked" option in the no-handoff menu. */
  get hasParentLink(): boolean {
    return this.parentLink !== undefined
  }

  /** HandoffSink: record `from`'s chosen handoff target for this turn. */
  register(from: string, to: string): void {
    this.pendingHandoff.set(from, to)
  }

  /** HandoffSink: peek `from`'s registration without consuming it. The tool
   *  rejects a second handoff call in the same turn with this; the Room reads
   *  it to stamp `handoffTo` on the transcript entry before consuming. */
  peekHandoff(from: string): string | undefined {
    return this.pendingHandoff.get(from)
  }

  /** Consume (get-and-clear) the pending handoff target for `from`, if any.
   *  Called once per turn by Room when resolving that agent's reply. */
  takeHandoff(from: string): string | undefined {
    const to = this.pendingHandoff.get(from)
    this.pendingHandoff.delete(from)
    return to
  }

  // ── GoalVerdictSink ────────────────────────────────────────────────────────
  /** Evaluator seat the goal_verdict tool is built for. Defaults to the Room
   *  default ("planner") and is updated by Room on submitGoal — but tools are
   *  built at participant creation, so a goal submitted later with a
   *  DIFFERENT evaluator leaves that seat without the tool. Documented
   *  degradation: the eval loop's token fallback + format-repair retry still
   *  carry that case (same build-time-snapshot tradeoff as the handoff enum). */
  private goalEvaluatorHint = "planner"
  /** True while an eval-mode goal is running — the tool's live gate. */
  private goalEvalRunning = false
  /** Verdict registered by the goal_verdict tool during the current eval
   *  pass. Room clears it before each pass and consumes it once after the
   *  drain (same lifecycle as pendingHandoff). */
  private pendingVerdict: { from: string; met: boolean; reason: string } | null = null

  /** GoalVerdictSink: evaluator seat — read at tool build time. */
  goalEvaluatorId(): string {
    return this.goalEvaluatorHint
  }
  setGoalEvaluator(id: string): void {
    this.goalEvaluatorHint = id
  }
  /** GoalVerdictSink: live gate — true only while an eval-mode goal runs. */
  goalEvalActive(): boolean {
    return this.goalEvalRunning
  }
  setGoalEvalActive(active: boolean): void {
    this.goalEvalRunning = active
  }
  /** GoalVerdictSink: record the eval pass verdict. First call stands — the
   *  tool rejects a second call via peekVerdict before ever reaching here. */
  registerVerdict(from: string, met: boolean, reason: string): void {
    if (this.pendingVerdict) return
    this.pendingVerdict = { from, met, reason }
  }
  /** GoalVerdictSink: peek without consuming (the tool's double-call guard). */
  peekVerdict(): { from: string; met: boolean } | undefined {
    return this.pendingVerdict ?? undefined
  }
  /** Consume (get-and-clear) the pass verdict. Called once per eval pass by
   *  Room after the drain. */
  takeVerdict(): { from: string; met: boolean; reason: string } | undefined {
    const v = this.pendingVerdict ?? undefined
    this.pendingVerdict = null
    return v
  }
  /** Drop any stale verdict before an eval pass starts. */
  clearVerdict(): void {
    this.pendingVerdict = null
  }

  /** Declarative handoff gates for this room — set by the Room whenever its
   *  config changes; enforced live by checkGate() at handoff execution. */
  private handoffGates: HandoffGate[] = []

  setHandoffGates(gates: HandoffGate[]): void {
    this.handoffGates = gates
  }

  /** HandoffSink: the roster-awareness block for `selfId` — one line per
   *  active seat with the RESOLVED model (pin ?? room default) and a compact
   *  tool summary. During a reset() batch, reads the incoming states so the
   *  first-created persona still sees the whole team. */
  describeRoster(self: string | string[]): string | null {
    const fallback = this.defaultModelRef() ?? null
    let members: RosterMemberInfo[]
    if (this.pendingRosterStates) {
      const states = this.pendingRosterStates.filter((st) => st.active)
      // Seat clusters from the incoming states (the seat runtimes are still
      // being built) — defused seats read as singletons.
      const mates = new Map<string, string[]>()
      for (const [seatId, hats] of clusterBySeat(states)) {
        if (this.defusedSeats.has(seatId) || hats.length < 2) continue
        for (const h of hats) mates.set(h.id, hats.filter((o) => o.id !== h.id).map((o) => o.id))
      }
      members = states.map((st) => ({
        id: st.id,
        name: st.name,
        modelRef: st.model ?? fallback,
        tools: st.tools,
        vision: st.vision,
        ...(mates.has(st.id) ? { seatId: seatIdOf(st), seatMates: mates.get(st.id) } : {}),
      }))
    } else {
      members = this.activeParticipants().map((p) => ({
        id: p.persona.id,
        name: p.persona.name,
        modelRef: p.persona.model ?? fallback,
        tools: p.persona.tools,
        vision: p.persona.vision,
        ...(p.seat.fused()
          ? { seatId: p.seat.seatId, seatMates: p.seat.hatIds().filter((id) => id !== p.persona.id) }
          : {}),
      }))
    }
    if (members.length === 0) return null
    return describeRosterBlock(members, self)
  }

  /** Push a fresh roster block (+ a one-line reason) to every active agent
   *  as a hidden nextTurn note — the work-receipt channel. Fired on
   *  incremental mutations only: a reset() batch recreates every session
   *  with a fresh block anyway, so it stays silent (pendingRosterStates
   *  doubles as the batch flag). Fire-and-forget: a failed delivery must
   *  never block the mutation that triggered it. */
  private notifyRosterChange(reason: string): void {
    if (this.pendingRosterStates) return
    // One note per SEAT, not per participant — a fused seat is one session,
    // and two copies of the same block would just burn its shared context.
    const notified = new Set<SeatRuntime>()
    for (const p of this.activeParticipants()) {
      if (notified.has(p.seat)) continue
      notified.add(p.seat)
      const block = this.describeRoster(p.seat.fused() ? p.seat.hatIds() : p.persona.id)
      if (!block) continue
      void p
        .sendCustomMessage(
          { customType: "roster_update", content: `${block}\n(Roster change: ${reason})`, display: false },
          { deliverAs: "nextTurn" },
        )
        .catch(() => { /* agent mid-dispose or session gone — the next block is in its rebuilt prompt */ })
    }
  }

  getHandoffGates(): HandoffGate[] {
    return this.handoffGates
  }

  /** HandoffSink: check `from` → `to` against the room's gates, using the
   *  caller's CURRENT-turn tool activity for path arming (the handoff tool
   *  executes mid-turn, before any receipt exists). Returns a correctable
   *  error message when blocked, null when allowed. */
  checkGate(from: string, to: string): string | null {
    if (this.handoffGates.length === 0) return null
    const activity = this.participants.get(from)?.liveActivity() ?? []
    return checkHandoffGates(
      this.handoffGates,
      from,
      to,
      activity,
      this.workspaceDir,
      this.activeIds(),
    )
  }

  /** Root directory for on-disk pi sessions, scoped to the current conversation
   *  (…/agents/<convId>). Each participant gets <root>/<personaId>. null →
   *  in-memory sessions (persistence off, or a Room that never set a scope —
   *  which is how existing tests keep the old behavior). */
  private sessionRoot: string | null = null

  setSessionRoot(root: string | null): void {
    this.sessionRoot = root
  }

  private sessionDirFor(seatId: string): string | undefined {
    return this.sessionRoot ? resolve(this.sessionRoot, seatId) : undefined
  }

  /** Resolved seat id for a persona, honoring defusions (a defused seat's
   *  members run as singletons). */
  private effectiveSeatId(persona: Persona): string {
    const seatId = seatIdOf(persona)
    return this.defusedSeats.has(seatId) ? persona.id : seatId
  }

  /** The dependency bundle a SeatRuntime builds its session from. */
  private seatDeps(seatId: string): SeatDeps {
    return {
      resolved: this.resolved,
      workspaceDir: this.workspaceDir,
      orchestrator: this.orchestrator,
      defaultThinkingLevel: this.defaultThinkingLevel,
      allowCloud: this.allowCloud,
      compactionReserveTokens: this.compactionReserveTokens,
      sessionDir: this.sessionDirFor(seatId),
      taskBoard: this.taskBoard,
      roomId: this.roomId,
      parentLink: this.parentLink,
      handoffSink: this,
      goalVerdictSink: this,
    }
  }

  /** Seat id a live participant's context runs on (room traces — the
   *  hat-switch suffix — and the UI read this). */
  seatOf(id: string): string | undefined {
    return this.participants.get(id)?.seat.seatId
  }

  /** Loud surface for seat warnings: the room transcript when wired, the
   *  server log always. */
  private warnSeat(message: string): void {
    console.warn(`[seats] ${message}`)
    this.onSystemNote?.(`⚠ ${message}`)
  }

  constructor(
    private readonly resolved: ResolvedModel,
    private readonly hub: SseHub,
    /** Providers the user has explicitly enabled via /api/providers. */
    private readonly explicitlyEnabledProviders: Set<string> = new Set(),
    /** Directory each participant's file tools are confined to. Defaults to the
     *  pipeline workspace; per-room scopes override it. */
    private readonly workspaceDir: string = config.workspaceDir,
    /** Logical room this registry belongs to. Tags roster + participant SSE
     *  events so room-filtered clients don't receive another room's roster. */
    private readonly roomId: string = "default",
    /** Capability surface for spawning sub-rooms. Passed to each participant so
     *  orchestrator personas (the planner) get spawn/check/destroy_room tools.
     *  Undefined in tests and before the server wires it up. */
    private readonly orchestrator?: RoomOrchestrator,
    /** The room's shared task board — the SAME instance the Room persists and
     *  broadcasts. When present, every participant gets the task_* tools. */
    private readonly taskBoard?: TaskBoard,
    /** Link to the parent room, present only in spawned sub-rooms — grants
     *  every participant the ask_orchestrator escalation tool. */
    private readonly parentLink?: ParentLink,
  ) {}

  /** Default thinking level for new participants without a per-agent override.
   *  Mutable — the Room can change it at runtime and existing participants
   *  keep their current level; only new participants pick up the change. */
  private defaultThinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" = config.thinkingLevel

  setDefaultThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): void {
    this.defaultThinkingLevel = level
  }

  getDefaultThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" {
    return this.defaultThinkingLevel
  }

  /** "provider/id" of the process default model — what a persona without a
   *  pinned model actually runs on. undefined when relying on pi's own
   *  resolution (no explicit model resolved at startup). */
  defaultModelRef(): string | undefined {
    const m = this.resolved.model
    return m ? `${m.provider}/${m.id}` : undefined
  }

  /** Whether cloud models are allowed in this room. Mutable — the Room can
   *  change it at runtime; only new participants pick up the change. */
  private allowCloud: boolean = config.allowCloud

  setAllowCloud(value: boolean): void {
    this.allowCloud = value
  }

  getAllowCloud(): boolean {
    return this.allowCloud
  }

  /** Reserve tokens for auto-compaction. Mutable — the Room can change it at
   *  runtime; only new participants pick up the change. */
  private compactionReserveTokens: number = 38000

  setCompactionReserveTokens(value: number): void {
    this.compactionReserveTokens = value
  }

  getCompactionReserveTokens(): number {
    return this.compactionReserveTokens
  }

  /** Participants that should take part in the loop, in insertion order. */
  activeParticipants(): Participant[] {
    return [...this.participants.values()].filter((p) => p.active)
  }

  /** Snapshot of the roster as personas + runtime flags, for persistence. */
  personaStates(): PersonaState[] {
    return [...this.participants.values()].map((p) => ({
      ...p.persona,
      active: p.active,
      parallel: p.parallel,
      cursor: p.cursor,
    }))
  }

  get(id: string): Participant | undefined {
    return this.participants.get(id)
  }

  /** The startup-resolved model bundle (registry + auth). Exposed for the
   *  supervised-routing decision runner, which builds its own ephemeral
   *  session outside any Participant. */
  get resolvedModel(): ResolvedModel {
    return this.resolved
  }

  has(id: string): boolean {
    return this.participants.has(id)
  }

  roster(): RosterItem[] {
    return [...this.participants.values()].map((p) => {
      const item: RosterItem = {
        id: p.persona.id,
        name: p.persona.name,
        color: p.persona.color,
        icon: p.persona.icon,
        tools: p.persona.tools,
        active: p.active,
        status: p.status,
        model: p.persona.model,
        thinkingLevel: p.persona.thinkingLevel,
        vision: p.persona.vision,
        parallel: p.parallel,
      }
      if (p.seat.fused()) item.seat = p.seat.seatId
      const usage = p.getContextUsage?.()
      if (usage) item.contextUsage = usage
      const stats = p.getSessionStats?.()
      if (stats) item.sessionStats = stats
      return item
    })
  }

  broadcastRoster(): void {
    this.hub.broadcast("roster", this.roster(), this.roomId)
  }

  async create(persona: Persona, active = true, parallel = false, savedCursor?: number): Promise<Participant> {
    if (this.participants.has(persona.id)) {
      throw new Error(`participant "${persona.id}" already exists`)
    }
    let seatId = this.effectiveSeatId(persona)
    let seat = this.seats.get(seatId)
    if (seat) {
      // One seat = one modelRef: a newcomer pinning a DIFFERENT model than the
      // live seat defuses ITSELF into a singleton (the existing seat keeps its
      // context — less disruptive than splitting a lived-in session; whole-seat
      // defusion applies at batch load, see reset()). DECLARED refs on purpose,
      // same universe as validateSeatModels: resolution varies by environment
      // (a missing GGUF falls back to the default model) and must not silently
      // fuse contexts the preset meant to keep on different brains.
      const seatRef = seat.hats[0]?.model ?? this.defaultModelRef() ?? "(process default)"
      const newRef = persona.model ?? this.defaultModelRef() ?? "(process default)"
      if (newRef !== seatRef) {
        this.warnSeat(
          `@${persona.id} declares seat "${seatId}" but runs ${newRef} while the seat runs ${seatRef} — ` +
            `joining as its own context instead (seat == persona).`,
        )
        seatId = persona.id
        seat = this.seats.get(seatId)
      }
    }
    if (!seat) {
      seat = await SeatRuntime.create(seatId, [persona], this.seatDeps(seatId))
      this.seats.set(seatId, seat)
    } else {
      // Mid-conversation join: the newcomer opens its eyes in the seat's
      // living context (grilling Q2 — this is the feature).
      await seat.addHat(persona)
    }
    const participant = Participant.attach(
      persona,
      seat,
      (event, data) => this.hub.broadcast(event, data, this.roomId),
      this.workspaceDir,
      this,
    )
    // A resumed on-disk session already holds everything up to the saved
    // cursor — restoring it avoids replaying that context a second time. A
    // fresh session ignores the saved value and catches up on the whole
    // transcript before its first turn. Seat-level: hats of a fused seat
    // persist the same value; max() keeps the furthest-seen entry when a
    // batch restores them one by one.
    participant.cursor = participant.resumed ? Math.max(seat.cursor, savedCursor ?? 0) : 0
    participant.active = active
    participant.parallel = parallel
    this.participants.set(persona.id, participant)
    this.broadcastRoster()
    this.onChange?.()
    this.notifyRosterChange(`@${persona.id} joined the room`)
    return participant
  }

  /** Editable persona fields (id is immutable — it is the @mention handle). */
  async update(
    id: string,
    patch: Partial<Pick<Persona, "name" | "color" | "icon" | "tools" | "systemPrompt" | "model" | "thinkingLevel">>,
  ): Promise<Participant> {
    const existing = this.participants.get(id)
    if (!existing) throw new Error(`unknown participant "${id}"`)
    const order = [...this.participants.keys()]
    const wasActive = existing.active
    const wasParallel = existing.parallel
    const persona: Persona = { ...existing.persona, ...patch, id }

    // The pi session is rebuilt rather than mutated in place: pi reconstructs
    // the system prompt from the resource loader on every open, so a persisted
    // session reopens with the edited persona AND its conversation memory
    // intact. Only when persistence is off does the old fresh-session path
    // (cursor=0, replay the transcript) apply.
    const cursorBefore = existing.cursor
    existing.dispose()
    let seat = existing.seat
    // Declared refs, same universe as create()'s join check and
    // validateSeatModels — never the environment-dependent resolved ref.
    const seatRef = seat.hats.find((h) => h.id !== id)?.model ?? this.defaultModelRef() ?? "(process default)"
    const newRef = persona.model ?? this.defaultModelRef() ?? "(process default)"
    if (seat.fused() && newRef !== seatRef) {
      // Model edit breaking the one-seat-one-modelRef invariant: the edited
      // hat defuses into a singleton (fresh context — the orphaning semantics
      // of grilling Q2), the rest of the seat lives on. Loud, never silent.
      this.warnSeat(
        `@${id} now runs ${newRef} while its "${seat.seatId}" seat runs ${seatRef} — ` +
          `detached to its own context (seat == persona).`,
      )
      await seat.removeHat(id)
      const soloId = persona.id
      const solo = await SeatRuntime.create(soloId, [persona], this.seatDeps(soloId))
      this.seats.set(soloId, solo)
      seat = solo
    } else {
      await seat.replaceHat(persona)
    }
    const replacement = Participant.attach(
      persona,
      seat,
      (event, data) => this.hub.broadcast(event, data, this.roomId),
      this.workspaceDir,
      this,
    )
    if (replacement.resumed) {
      replacement.cursor = Math.max(seat.cursor, cursorBefore)
    } else {
      replacement.cursor = 0
    }
    replacement.active = wasActive
    replacement.parallel = wasParallel

    // Rebuild the Map in the original order (a plain set() would move it last,
    // reordering @all / first-active routing).
    const rebuilt = new Map<string, Participant>()
    for (const key of order) {
      rebuilt.set(key, key === id ? replacement : this.participants.get(key)!)
    }
    this.participants = rebuilt

    this.broadcastRoster()
    this.onChange?.()
    // Tell the OTHER seats — the edited one was just rebuilt with a fresh
    // block in its own system prompt. Model changes are what teammates care
    // about most (a brief for Opus reads differently than one for a 27B).
    const modelNote = patch.model !== undefined ? ` (model: ${persona.model ?? this.defaultModelRef() ?? "room default"})` : ""
    this.notifyRosterChange(`@${id} was reconfigured${modelNote}`)
    return replacement
  }

  /** After a transcript rollback to `keep` entries: wipe — from scratch,
   *  on-disk session deleted — every SEAT whose cursor advanced past the cut,
   *  because its private pi context literally contains the removed messages.
   *  cursor=0 → the seat replays the kept transcript on its next turn. Seats
   *  still at or behind the cut are left untouched. The SeatRuntime objects
   *  survive (participants keep their references); only sessions rebuild. */
  async rollbackSessions(keep: number): Promise<void> {
    let changed = false
    for (const seat of new Set([...this.participants.values()].map((p) => p.seat))) {
      if (seat.cursor <= keep) continue
      changed = true
      await seat.wipe()
    }
    if (changed) {
      this.broadcastRoster()
      this.onChange?.()
    }
  }

  /** Reorder the roster to match the given id sequence. This is the first-turn /
   *  @all execution order (and the first-active fallback default). Ids not listed
   *  keep their relative order, appended after the listed ones. No session is
   *  recreated — only references move — so it is safe to call mid-turn. */
  reorder(orderedIds: string[]): void {
    const seen = new Set<string>()
    const next: string[] = []
    for (const id of orderedIds) {
      if (this.participants.has(id) && !seen.has(id)) {
        next.push(id)
        seen.add(id)
      }
    }
    for (const id of this.participants.keys()) if (!seen.has(id)) next.push(id)

    const rebuilt = new Map<string, Participant>()
    for (const id of next) rebuilt.set(id, this.participants.get(id)!)
    this.participants = rebuilt

    this.broadcastRoster()
    this.onChange?.()
  }

  setActive(id: string, active: boolean): Participant {
    const p = this.participants.get(id)
    if (!p) throw new Error(`unknown participant "${id}"`)
    p.active = active
    p.status = "idle"
    this.broadcastRoster()
    this.onChange?.()
    this.notifyRosterChange(`@${id} was ${active ? "activated" : "deactivated"}`)
    return p
  }

  /** Toggle whether an agent may run concurrently. Pure runtime flag — no
   *  session recreation, so it is safe to flip anytime (takes effect next turn). */
  setParallel(id: string, parallel: boolean): Participant {
    const p = this.participants.get(id)
    if (!p) throw new Error(`unknown participant "${id}"`)
    p.parallel = parallel
    this.broadcastRoster()
    this.onChange?.()
    return p
  }

  /** In-place thinking level change — no session recreation. Takes effect next turn. */
  async setThinkingLevel(
    id: string,
    level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
  ): Promise<Participant> {
    const p = this.participants.get(id)
    if (!p) throw new Error(`unknown participant "${id}"`)
    await p.setThinkingLevel(level)
    this.broadcastRoster()
    this.onChange?.()
    return p
  }

  /** Toggle whether an agent receives image attachments. Pure runtime flag — no
   *  session recreation, so it is safe to flip anytime (takes effect next turn). */
  setVision(id: string, vision: boolean): Participant {
    const p = this.participants.get(id)
    if (!p) throw new Error(`unknown participant "${id}"`)
    p.setVision(vision)
    this.broadcastRoster()
    this.onChange?.()
    return p
  }

  /** Refcounted kick (grilling Q7): the hat leaves; the seat's session and
   *  its on-disk dir survive while another hat lives there, and are dropped
   *  only with the LAST hat — a future agent created with the same id must
   *  not wake up with this seat's memory. */
  async kick(id: string): Promise<void> {
    const p = this.participants.get(id)
    if (!p) throw new Error(`unknown participant "${id}"`)
    const seat = p.seat
    const dir = seat.sessionDir
    p.dispose()
    this.participants.delete(id)
    const empty = await seat.removeHat(id)
    if (empty) {
      this.seats.delete(seat.seatId)
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
    this.notifyRosterChange(`@${id} left the room`)
    this.broadcastRoster()
    this.onChange?.()
  }

  /** Replace the whole roster with a saved persona set. Sessions are reopened
   *  from disk when a session root is set (restoring each agent's private
   *  context), fresh otherwise. Used when loading/switching conversations.
   *  Does not fire onChange. */
  async reset(states: PersonaState[]): Promise<void> {
    const cb = this.onChange
    this.onChange = null // suppress per-participant autosave during a bulk swap
    // See pendingRosterIds' doc comment: without this, the first persona in
    // the batch builds its handoff tool against an empty roster and never
    // gets it. Only active personas count — an inactive one isn't a valid
    // handoff target even prospectively.
    this.pendingRosterIds = new Set(states.filter((s) => s.active).map((s) => s.id))
    this.pendingRosterStates = states
    try {
      for (const p of this.participants.values()) p.dispose()
      this.participants.clear()
      for (const seat of this.seats.values()) seat.dispose()
      this.seats.clear()
      // One-seat-one-modelRef, validated batch-wide: violating seats defuse
      // WHOLE (each member its own context) with a loud warning — a
      // deterministic fallback, never an arbitrary winner.
      const { warnings, defused } = validateSeatModels(states, (s) => s.model ?? this.defaultModelRef())
      this.defusedSeats = defused
      for (const w of warnings) this.warnSeat(w)
      for (const s of states) {
        const { active, parallel, cursor, ...persona } = s
        await this.create(persona, active, parallel ?? false, cursor)
      }
    } finally {
      this.onChange = cb
      this.pendingRosterIds = null
      this.pendingRosterStates = null
    }
    this.broadcastRoster()
  }

  disposeAll(): void {
    for (const p of this.participants.values()) p.dispose()
    this.participants.clear()
    for (const seat of this.seats.values()) seat.dispose()
    this.seats.clear()
  }

  /** True if a "provider/id" ref is a model the UI is allowed to assign. */
  isAllowedModel(ref: string): boolean {
    return isAllowedModel_(this.resolved, this.allowCloud, ref, this.explicitlyEnabledProviders)
  }

  // ── Provider auth (for /provider slash command) ──────────────────────────

  /** Get all providers with their auth status (no secrets). */
  getProviderList(): Array<{ name: string; displayName: string; configured: boolean; models: number }> {
    const all = this.resolved.modelRegistry.getAll()
    const providerSet = new Set(all.map((m) => m.provider))
    return Array.from(providerSet).map((name) => ({
      name,
      displayName: this.resolved.modelRegistry.getProviderDisplayName(name),
      configured: this.resolved.modelRegistry.getProviderAuthStatus(name).configured,
      models: all.filter((m) => m.provider === name).length,
    }))
  }

  /** Set an API key for a provider (persisted). Returns auth status, not the key. */
  setProviderKey(name: string, key: string): { name: string; configured: boolean } {
    this.resolved.authStorage.set(name, { type: "api_key", key })
    this.explicitlyEnabledProviders.add(name)
    this.resolved.modelRegistry.refresh()
    return { name, configured: this.resolved.modelRegistry.getProviderAuthStatus(name).configured }
  }

  /** Remove credentials for a provider. Returns auth status. */
  removeProviderKey(name: string): { name: string; configured: boolean } {
    this.resolved.authStorage.remove(name)
    this.explicitlyEnabledProviders.delete(name)
    this.resolved.modelRegistry.refresh()
    return { name, configured: this.resolved.modelRegistry.getProviderAuthStatus(name).configured }
  }
}
