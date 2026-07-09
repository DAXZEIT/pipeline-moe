// The participant registry: the live roster of agents. Create / activate /
// deactivate / kick all happen here. Emits a "roster" SSE event on any change.

import { rmSync } from "node:fs"
import { resolve } from "node:path"
import { config } from "./config.js"
import { isAllowedModel as isAllowedModel_ } from "./model.js"
import { Participant } from "./participant.js"
import type { ResolvedModel } from "./model.js"
import type { ParentLink, RoomOrchestrator } from "./orchestrator.js"
import type { TaskBoard } from "./task-board.js"
import type { SseHub } from "./sse.js"
import type { HandoffSink, Persona, PersonaState } from "./types.js"

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

export class Registry implements HandoffSink {
  private participants = new Map<string, Participant>()
  /** Fired after any roster mutation (create/activate/kick). Used for autosave. */
  onChange: (() => void) | null = null
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

  /** Consume (get-and-clear) the pending handoff target for `from`, if any.
   *  Called once per turn by Room when resolving that agent's reply. */
  takeHandoff(from: string): string | undefined {
    const to = this.pendingHandoff.get(from)
    this.pendingHandoff.delete(from)
    return to
  }

  /** Root directory for on-disk pi sessions, scoped to the current conversation
   *  (…/agents/<convId>). Each participant gets <root>/<personaId>. null →
   *  in-memory sessions (persistence off, or a Room that never set a scope —
   *  which is how existing tests keep the old behavior). */
  private sessionRoot: string | null = null

  setSessionRoot(root: string | null): void {
    this.sessionRoot = root
  }

  private sessionDirFor(personaId: string): string | undefined {
    return this.sessionRoot ? resolve(this.sessionRoot, personaId) : undefined
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
    const participant = await Participant.create(
      persona,
      this.resolved,
      (event, data) => this.hub.broadcast(event, data, this.roomId),
      this.workspaceDir,
      this.orchestrator,
      this.defaultThinkingLevel,
      this.allowCloud,
      this.compactionReserveTokens,
      this.sessionDirFor(persona.id),
      this.taskBoard,
      this.roomId,
      this.parentLink,
      this,
    )
    // A resumed on-disk session already holds everything up to the saved
    // cursor — restoring it avoids replaying that context a second time. A
    // fresh session ignores the saved value and catches up on the whole
    // transcript before its first turn.
    participant.cursor = participant.resumed ? (savedCursor ?? 0) : 0
    participant.active = active
    participant.parallel = parallel
    this.participants.set(persona.id, participant)
    this.broadcastRoster()
    this.onChange?.()
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
    const persona: Persona = { ...existing.persona, ...patch, id }

    // The pi session is rebuilt rather than mutated in place: pi reconstructs
    // the system prompt from the resource loader on every open, so a persisted
    // session reopens with the edited persona AND its conversation memory
    // intact. Only when persistence is off does the old fresh-session path
    // (cursor=0, replay the transcript) apply.
    const cursorBefore = existing.cursor
    existing.dispose()
    const replacement = await Participant.create(
      persona,
      this.resolved,
      (event, data) => this.hub.broadcast(event, data, this.roomId),
      this.workspaceDir,
      this.orchestrator,
      this.defaultThinkingLevel,
      this.allowCloud,
      this.compactionReserveTokens,
      this.sessionDirFor(id),
      this.taskBoard,
      this.roomId,
      this.parentLink,
      this,
    )
    replacement.cursor = replacement.resumed ? cursorBefore : 0
    replacement.active = wasActive

    // Rebuild the Map in the original order (a plain set() would move it last,
    // reordering @all / first-active routing).
    const rebuilt = new Map<string, Participant>()
    for (const key of order) {
      rebuilt.set(key, key === id ? replacement : this.participants.get(key)!)
    }
    this.participants = rebuilt

    this.broadcastRoster()
    this.onChange?.()
    return replacement
  }

  /** After a transcript rollback to `keep` entries: rebuild — from scratch,
   *  on-disk session wiped — every participant whose cursor advanced past the
   *  cut, because its private pi context literally contains the removed
   *  messages. cursor=0 → it replays the kept transcript on its next turn.
   *  Participants still at or behind the cut are left untouched. */
  async rollbackSessions(keep: number): Promise<void> {
    const order = [...this.participants.keys()]
    let changed = false
    for (const id of order) {
      const p = this.participants.get(id)!
      if (p.cursor <= keep) continue
      changed = true
      const { active, parallel, persona } = { active: p.active, parallel: p.parallel, persona: p.persona }
      p.dispose()
      if (p.sessionDir) rmSync(p.sessionDir, { recursive: true, force: true })
      const fresh = await Participant.create(
        persona,
        this.resolved,
        (event, data) => this.hub.broadcast(event, data, this.roomId),
        this.workspaceDir,
        this.orchestrator,
        this.defaultThinkingLevel,
        this.allowCloud,
        this.compactionReserveTokens,
        this.sessionDirFor(id),
        this.taskBoard,
        this.roomId,
        this.parentLink,
        this,
      )
      fresh.cursor = 0
      fresh.active = active
      fresh.parallel = parallel
      this.participants.set(id, fresh) // same key → map order preserved
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

  kick(id: string): void {
    const p = this.participants.get(id)
    if (!p) throw new Error(`unknown participant "${id}"`)
    p.dispose()
    // Drop the on-disk session too — a future agent created with the same id
    // must not wake up with this one's memory.
    if (p.sessionDir) rmSync(p.sessionDir, { recursive: true, force: true })
    this.participants.delete(id)
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
    try {
      for (const p of this.participants.values()) p.dispose()
      this.participants.clear()
      for (const s of states) {
        const { active, parallel, cursor, ...persona } = s
        await this.create(persona, active, parallel ?? false, cursor)
      }
    } finally {
      this.onChange = cb
      this.pendingRosterIds = null
    }
    this.broadcastRoster()
  }

  disposeAll(): void {
    for (const p of this.participants.values()) p.dispose()
    this.participants.clear()
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
