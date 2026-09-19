import { config } from "../config.js"
import { rosterDeviatesFromPreset } from "../preset-hydration.js"
import type { HandoffGate, PersonaState, RoutingMode } from "../types.js"
import { RoomCore } from "./room-core.js"

export abstract class RoomSettings extends RoomCore {
  /** Anti-loop: max chain hops per turn. Prevents A→B→A infinite loops. */
  protected maxChainHops = 30

  /** Agent that decides handoff proposals in `supervised` mode (accept /
   *  refuse / transfer). null = no supervisor → supervised hops degrade to
   *  auto. Default "planner" — same rationale as fallbackAgentId. */
  protected supervisorAgentId: string | null = "planner"

  /** Declarative review gates on agent handoffs (e.g. builder must route src/**
   *  work through the auditor). Mirrored into the Registry, which enforces them
   *  live inside the handoff tool. Persisted per conversation. */
  protected handoffGates: HandoffGate[] = []

  // ── Preset provenance & drift (« line-up ≠ preset ») ────────────────────────
  /** Name of the preset the live conversation was born from. Undefined → ad-hoc
   *  room, drift tracking dormant. Persisted as `sourcePreset` on the Conversation. */
  protected convSourcePreset: string | undefined
  /** In-memory normalized snapshot of the preset DOCUMENT to diff the live roster
   *  against. Set from the personas at load/apply/push; reloaded from disk on
   *  reboot via `presetReader`. Undefined → no baseline → drift dormant. */
  protected presetBaseline: PersonaState[] | undefined
  /** Whether the single deviation notice has already fired for the CURRENT drift.
   *  Latch: one line per false→true transition, re-armed when the roster returns
   *  to the preset (pull/push). Prevents a per-turn spam of the same notice. */
  protected driftLatched = false
  /** Injected file-IO bridge so the room can re-read a preset document (rehydrated)
   *  to rebuild `presetBaseline` after a reboot. Server wires it; absent in tests
   *  → drift stays dormant until the next in-session load/apply. */
  protected presetReader?: (name: string) => Promise<PersonaState[] | null>

  /** Default thinking level for agents without a per-agent override.
   *  Mutable — can be changed per-room via the Settings panel.
   *  Propagated to the Registry so new participants use it. */
  protected defaultThinkingLevel:
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh" = config.thinkingLevel

  /** Whether cloud models are allowed in this room. Mutable — can be toggled
   *  per-room via the Settings panel. Propagated to the Registry so new
   *  participants use the room's policy. */
  protected allowCloud: boolean = config.allowCloud

  /** Reserve tokens for auto-compaction. Mutable — can be changed per-room via
   *  the Settings panel. Propagated to the Registry so new participants use
   *  the room's value. */
  protected compactionReserveTokens: number = 38000

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
    if (id !== null && !this.registry.has(id))
      throw new Error(`unknown participant "${id}"`)
    this.defaultAgentId = id
    this.broadcastSettings()
    void this.saveCurrent()
  }

  getFallbackAgent(): string | null {
    return this.fallbackAgentId
  }

  /** Set the agent that receives routing fallback. null = disabled. */
  setFallbackAgent(id: string | null): void {
    if (id !== null && !this.registry.has(id))
      throw new Error(`unknown participant "${id}"`)
    this.fallbackAgentId = id
    this.broadcastSettings()
    void this.saveCurrent()
  }

  getSupervisorAgent(): string | null {
    return this.supervisorAgentId
  }

  /** Set the agent that decides supervised handoffs. null = no supervisor
   *  (supervised hops degrade to auto). Like fallbackAgent, the id must name
   *  a current roster member when non-null. */
  setSupervisorAgent(id: string | null): void {
    if (id !== null && !this.registry.has(id))
      throw new Error(`unknown participant "${id}"`)
    this.supervisorAgentId = id
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

  getHandoffGates(): HandoffGate[] {
    return this.handoffGates
  }

  /** Replace the room's handoff gates. Ids are NOT validated against the
   *  roster on purpose: a gate naming an absent agent is dormant, not an
   *  error — presets and rosters evolve independently. */
  setHandoffGates(gates: HandoffGate[]): void {
    this.handoffGates = gates
    this.registry.setHandoffGates?.(gates)
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

  getDefaultThinkingLevel():
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh" {
    return this.defaultThinkingLevel
  }

  setDefaultThinkingLevel(
    level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
  ): void {
    this.defaultThinkingLevel = level
    // Propagate to registry so new participants use the updated default.
    this.registry.setDefaultThinkingLevel(level)
    this.broadcastSettings()
    void this.saveCurrent()
  }

  /** "provider/id" the room's default-model agents actually run on — resolved
   *  once at startup, surfaced so clients can label "default" concretely. */
  getDefaultModel(): string | null {
    // Optional call: test doubles stand in for the Registry without it.
    return this.registry.defaultModelRef?.() ?? null
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
    this.compactionReserveTokens = Math.max(
      5000,
      Math.min(100000, Math.round(value)),
    )
    // Propagate to registry so new participants use the updated value.
    this.registry.setCompactionReserveTokens(this.compactionReserveTokens)
    this.broadcastSettings()
    void this.saveCurrent()
  }

  protected broadcastSettings(): void {
    this.emit("settings", {
      chaining: this.chaining,
      routingMode: this.routingMode,
      defaultAgent: this.defaultAgentId,
      fallbackAgent: this.fallbackAgentId,
      supervisorAgent: this.supervisorAgentId,
      planAwareRouting: this.planAwareRoutingEnabled,
      maxChainHops: this.maxChainHops,
      defaultThinkingLevel: this.defaultThinkingLevel,
      allowCloud: this.allowCloud,
      compactionReserveTokens: this.compactionReserveTokens,
      defaultModel: this.getDefaultModel(),
      handoffGates: this.handoffGates,
      drift: this.computeDrift(),
      roomUsage: this.getRoomUsage(),
    })
  }

  /** The ONE compaction entry point. Every door — the internal `/compact`
   *  slash command AND the two REST endpoints the TUI/Web actually call — routes
   *  here, so the refresh seam (`broadcastSettings()` after a successful compact)
   *  can't be present on one path and missing on another. That divergence was
   *  exactly dax's `353K`-stuck bug: the slash handler broadcast, the REST
   *  endpoints didn't, and the clients use REST (auditor, 2026-07-12).
   *  Broadcasts ONLY on success — a sub-floor/no-op or errored compaction changed
   *  nothing, so it must not emit a spurious refresh. `onStart` fires after
   *  validation passes, before the (slow) compaction, for caller-side feedback. */
  async compactParticipant(
    id: string,
    onStart?: () => void,
  ): Promise<
    | { ok: true; result: { summary: string; tokensBefore: number } }
    | { ok: false; reason: "unknown" | "generating" | "error"; message: string }
  > {
    const target = this.registry.get(id)
    if (!target)
      return {
        ok: false,
        reason: "unknown",
        message: `unknown participant "${id}"`,
      }
    // isGenerating, not isBusy: an ask_user pause holds pendingQuestion but the
    // room is quiescent — that's a safe (and useful) moment to compact.
    if (this.isGenerating()) {
      return {
        ok: false,
        reason: "generating",
        message: "agents are generating — press Stop or wait before compacting",
      }
    }
    onStart?.()
    try {
      const result = await target.compact()
      // Compaction shrank this seat's PERSONAL context (its session) — refresh
      // the per-agent roster gauge, which carries per-seat contextUsage. It does
      // NOT touch the room gauge: that counts the shared TRANSCRIPT, which a
      // seat compaction leaves untouched (dax, 2026-07-13 — personal ≠ group).
      // So broadcastRoster, not broadcastSettings: the room `ctx:` stays put.
      this.registry.broadcastRoster()
      return { ok: true, result }
    } catch (err) {
      return {
        ok: false,
        reason: "error",
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /** Wire the preset-document reader so drift survives a reboot. */
  setPresetReader(fn: (name: string) => Promise<PersonaState[] | null>): void {
    this.presetReader = fn
  }

  /** Public drift snapshot for the REST settings payload. Null when dormant. */
  getDrift(): { preset: string; deviates: boolean } | null {
    return this.computeDrift() ?? null
  }

  /** The preset this room was born from, or null when ad-hoc. Lets the server
   *  reject a /preset push aimed at anything other than the true source. */
  getSourcePreset(): string | null {
    return this.convSourcePreset ?? null
  }

  /** Adopt the LIVE roster as the new drift baseline after it was saved back to
   *  its source preset (/preset push). Drift clears, the latch re-arms, and the
   *  conversation is persisted immediately so a reboot re-reads the SAVED preset
   *  as baseline (no phantom drift). No-op for an ad-hoc room. */
  async rebaselineToCurrentRoster(): Promise<void> {
    if (!this.convSourcePreset) return
    this.presetBaseline = this.registry.personaStates()
    this.driftLatched = false
    this.broadcastSettings()
    await this.saveCurrent()
  }

  /** Stamp preset provenance onto a freshly-initialized room born from a preset
   *  (provisionRoom → createRoom → init, whose startFresh cleared it). The drift
   *  baseline is the born-with roster; persisted so badge/pull/push survive a
   *  reboot. Distinct from loadPreset (which starts a NEW discussion in an
   *  EXISTING room) — here the room itself is new and already initialized. */
  async adoptPresetProvenance(
    presetName: string,
    baseline: PersonaState[],
  ): Promise<void> {
    this.convSourcePreset = presetName
    this.presetBaseline = baseline
    this.driftLatched = false
    this.broadcastSettings()
    await this.saveCurrent()
  }

  /** Current drift state, or undefined when dormant (ad-hoc room, or no baseline
   *  yet). `deviates` is a pure diff of the live roster vs the preset document,
   *  both normalized so a seed-inherited roster reads as zero drift. */
  protected computeDrift(): { preset: string; deviates: boolean } | undefined {
    if (!this.convSourcePreset || !this.presetBaseline) return undefined
    const deviates = rosterDeviatesFromPreset(
      this.registry.personaStates(),
      this.presetBaseline,
    )
    return { preset: this.convSourcePreset, deviates }
  }

  /** Re-evaluate drift on a roster change: fire the ONE deviation notice on the
   *  false→true edge, re-arm the latch when the roster returns to the preset,
   *  and push the refreshed drift bit so the badge tracks live. */
  protected evaluateDrift(): void {
    const drift = this.computeDrift()
    if (!drift) {
      this.driftLatched = false
      return
    }
    if (drift.deviates && !this.driftLatched) {
      this.driftLatched = true
      this.post(
        "system",
        "Preset",
        `line-up deviates from preset "${drift.preset}" — /preset pull to restore it, /preset push to save it`,
      )
    } else if (!drift.deviates) {
      this.driftLatched = false
    }
    // NB: no broadcast here. The sole caller (registry.onChange) owns the
    // settings broadcast so EVERY roster/seat mutation refreshes the room-level
    // aggregate (roomUsage) too — not just drift. Broadcasting here would both
    // double-fire and, for an ad-hoc room (early return above), skip the refresh
    // the gauge needs after a kick/fuse/solo (auditor, 2026-07-12).
  }
}
