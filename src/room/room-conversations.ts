import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import { config } from "../config.js"
import { conversationMeta } from "../store.js"
import type {
  Conversation,
  ConversationMeta,
  PersonaState,
} from "../types.js"
import { newConvId } from "./room-core.js"
import { RoomRouting } from "./room-routing.js"

export abstract class RoomConversations extends RoomRouting {
  // ── Current conversation identity ──────────────────────────────────────────
  protected convId = newConvId()
  protected convTitle = "Discussion 1"
  protected convCreatedAt = Date.now()

  // ── Conversation lifecycle ──────────────────────────────────────────────────

  /** The room's seed roster as a fresh-start line-up. For the default room the
   *  seed is `Persona[]` (no `active`) so everyone defaults active; for a
   *  preset-BORN room the seed IS the preset's `PersonaState[]`, so its own
   *  `active` flags are honored — force-activating them made a preset with an
   *  inactive agent read as instant drift at birth (tester, 2026-07-12). */
  protected seedRoster(): PersonaState[] {
    return this.seedPersonas.map((p) => ({
      ...p,
      active: (p as PersonaState).active ?? true,
    }))
  }

  protected buildConversation(): Conversation {
    return {
      id: this.convId,
      title: this.convTitle,
      createdAt: this.convCreatedAt,
      updatedAt: Date.now(),
      chaining: this.chaining,
      routingMode: this.routingMode,
      defaultAgent: this.defaultAgentId,
      fallbackAgent: this.fallbackAgentId,
      supervisorAgent: this.supervisorAgentId,
      planAwareRouting: this.planAwareRoutingEnabled,
      defaultThinkingLevel: this.defaultThinkingLevel,
      allowCloud: this.allowCloud,
      compactionReserveTokens: this.compactionReserveTokens,
      ...(this.handoffGates.length > 0
        ? { handoffGates: this.handoffGates }
        : {}),
      ...(this.convSourcePreset ? { sourcePreset: this.convSourcePreset } : {}),
      personas: this.registry.personaStates(),
      transcript: this.transcript,
      tasks: this.taskBoard.serialize(),
    }
  }

  async getConversations(): Promise<{
    currentId: string
    list: ConversationMeta[]
  }> {
    return { currentId: this.convId, list: await this.store.list() }
  }

  protected async broadcastConversations(): Promise<void> {
    this.emit("conversations", {
      currentId: this.convId,
      list: await this.store.list(),
    })
  }

  /** Root for a conversation's on-disk agent sessions (pi JSONL files), or
   *  null when persistence is off. Lives next to the conversation JSON so a
   *  room's data — transcript AND agent memories — travels as one directory. */
  protected agentSessionRoot(convId: string): string | null {
    // Test doubles of ConversationStore may not expose baseDir — treat that
    // as persistence off (in-memory sessions, the pre-persistence behavior).
    const base = this.store.baseDir as string | undefined
    return config.persistAgentSessions && base
      ? resolve(base, "agents", convId)
      : null
  }

  /** Load the most recent saved conversation, or seed a fresh one. Wires autosave. */
  async init(): Promise<void> {
    await this.store.init()
    const metas = await this.store.list()
    const latest = metas[0] ? await this.store.read(metas[0].id) : null
    if (latest) {
      await this.applyConversation(latest)
    } else {
      await this.startFresh("Discussion 1", this.seedRoster())
    }
    // From now on, any roster change autosaves the current conversation AND
    // re-evaluates preset drift (fires the one-shot deviation notice, updates
    // the badge bit) — a fused/defused seat is exactly such a change.
    this.registry.onChange = () => {
      // Any roster/seat mutation (kick, activate, model edit, fuse/solo) lands
      // here. Recompute the drift latch, then broadcast settings UNCONDITIONALLY
      // so the room-level context gauge tracks the live seat topology — a fuse
      // changes the number of distinct seats, so the aggregate must refresh even
      // when there's no preset drift to report.
      this.evaluateDrift()
      this.broadcastSettings()
      this.scheduleSave()
    }
    // 🧠 reasoning-checkpoint traces (src/reasoning-budget.ts) land in the
    // transcript live — zero silent burn, same invariant as zero silent hop.
    this.registry.onSystemNote = (text) => this.post("system", "Budget", text)
  }

  /** Become a brand-new empty conversation with the given roster. */
  protected async startFresh(
    title: string,
    personas: Conversation["personas"],
  ): Promise<void> {
    this.convId = newConvId()
    this.convTitle = title
    this.convCreatedAt = Date.now()
    // Fresh discussion → no provenance until loadPreset re-stamps it (it calls
    // startFresh then sets convSourcePreset). newConversation leaves it cleared:
    // an inherited roster starts ad-hoc, drift dormant.
    this.convSourcePreset = undefined
    this.presetBaseline = undefined
    this.driftLatched = false
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
  protected async applyConversation(conv: Conversation): Promise<void> {
    this.convId = conv.id
    this.convTitle = conv.title
    this.convCreatedAt = conv.createdAt
    // Restore preset provenance. The baseline (preset document) can't be read
    // from here — file IO lives behind presetReader — so it's reloaded below
    // after the roster is in place. Until then drift stays dormant.
    this.convSourcePreset = conv.sourcePreset
    this.presetBaseline = undefined
    this.driftLatched = false
    this.registry.setSessionRoot?.(this.agentSessionRoot(conv.id))
    this.routingMode = conv.routingMode ?? (conv.chaining ? "auto" : "manual")
    this.defaultAgentId = conv.defaultAgent ?? null
    this.fallbackAgentId = conv.fallbackAgent ?? "planner"
    // Back-compat: older saves don't have supervisorAgent — default "planner".
    this.supervisorAgentId = conv.supervisorAgent ?? "planner"
    this.planAwareRoutingEnabled = conv.planAwareRouting ?? true
    this.handoffGates = conv.handoffGates ?? []
    this.registry.setHandoffGates?.(this.handoffGates)
    // Adoption is in-memory only: a freshly loaded conversation has adopted no
    // plan until one of its agents touches a plan again — safest default (no
    // stale plan can route on restart mid-workflow).
    this.activePlanId = null
    // Back-compat: older saves don't have these fields — fall back to config defaults.
    if (conv.defaultThinkingLevel) {
      const level = conv.defaultThinkingLevel as
        | "off"
        | "minimal"
        | "low"
        | "medium"
        | "high"
        | "xhigh"
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
      personas = this.seedRoster()
      healed = true
    }
    await this.registry.reset(personas)
    // Agents with a restored on-disk session keep their saved cursor (their
    // context already covers the transcript up to it); fresh sessions start at
    // cursor=0 and catch up on the whole transcript on their next turn.
    this.transcript = conv.transcript.map((e) => ({ ...e }))
    this.taskBoard.load(conv.tasks ?? []) // back-compat: older saves have no board
    // Rebuild the drift baseline from the preset document on disk (reboot/switch
    // path). Best-effort: a since-deleted preset or an unwired reader leaves
    // drift dormant rather than crashing the load. Compare AFTER the roster is
    // live so an already-deviated saved room re-latches correctly.
    if (this.convSourcePreset && this.presetReader) {
      try {
        const baseline = await this.presetReader(this.convSourcePreset)
        if (baseline) {
          this.presetBaseline = baseline
          const drift = this.computeDrift()
          this.driftLatched = drift?.deviates ?? false
        }
      } catch {
        // Unreadable preset → leave drift dormant.
      }
    }
    this.broadcastSettings()
    this.emit("transcript", this.transcript)
    this.broadcastTasks()
    if (healed) {
      this.notice(
        `"${conv.title}" had an empty roster — restored the seed agents.`,
        "info",
      )
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
  async loadPreset(
    personas: Conversation["personas"],
    title?: string,
    presetName?: string,
  ): Promise<ConversationMeta> {
    this.ensureIdle()
    await this.saveCurrent()
    const count = (await this.store.list()).length
    await this.startFresh(title?.trim() || `Discussion ${count + 1}`, personas)
    // Stamp provenance AFTER startFresh (which clears it). A freshly loaded
    // preset is by definition not deviated → baseline = the loaded personas,
    // latch disarmed.
    if (presetName) {
      this.convSourcePreset = presetName
      this.presetBaseline = personas
      this.driftLatched = false
      this.broadcastSettings()
      // Persist SYNCHRONOUSLY before returning: startFresh's save ran BEFORE the
      // stamp, so this second write is the only snapshot carrying sourcePreset.
      // Without awaiting, the HTTP 200 could precede it (setHandoffGates only
      // does void saveCurrent()) and a crash restores the room as ad-hoc — the
      // same write-then-persist invariant the other three provenance paths hold.
      await this.saveCurrent()
    }
    return conversationMeta(this.buildConversation())
  }

  /** Apply a preset roster to the current room — replaces agents in-place without
   *  changing the conversation id, title, or transcript. Persists immediately so
   *  the roster survives reboot. */
  async applyPreset(
    personas: Conversation["personas"],
    presetName?: string,
  ): Promise<ConversationMeta> {
    this.ensureIdle()
    // Stamp provenance BEFORE reset so the onChange fired by reset already sees
    // the fresh baseline (roster==preset → no spurious deviation notice).
    this.convSourcePreset = presetName
    this.presetBaseline = presetName ? personas : undefined
    this.driftLatched = false
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
      else await this.startFresh("Discussion 1", this.seedRoster())
    } else {
      await this.broadcastConversations()
    }
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
}
