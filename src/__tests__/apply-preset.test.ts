import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
import { SEED_PERSONAS } from "../personas.js"
import type { Persona, PersonaState } from "../types.js"

// ── Mocks ────────────────────────────────────────────────────────────────

class MockParticipant {
  persona: Persona
  active = true
  parallel = false
  status: "idle" | "active" | "thinking" | "working" = "idle"
  cursor = 0

  constructor(persona: Persona) {
    this.persona = persona
  }

  run(_ctx: { text: string; images?: string[] }): Promise<{
    reply: string; activity: unknown[]; reasoning?: string; question?: string; receipt: any
  }> {
    return Promise.reject(new Error("not implemented"))
  }
}

class MockRegistry {
  private states = new Map<string, PersonaState>()
  resetCalled = false
  lastResetStates: PersonaState[] = []

  constructor(initialPersonas: Persona[]) {
    for (const p of initialPersonas) {
      this.states.set(p.id, { ...p, active: true, parallel: false, systemPrompt: p.systemPrompt, model: undefined })
    }
  }

  has(id: string): boolean {
    return this.states.has(id)
  }

  get(id: string): MockParticipant | undefined {
    const s = this.states.get(id)
    if (!s) return undefined
    const p = new MockParticipant(s as any)
    ;(p as any).compact = async () => ({ tokensBefore: 999, summary: "compacted" })
    return p
  }

  personaStates(): PersonaState[] {
    // Return COPIES, like the real Registry (src/registry.ts personaStates maps
    // to fresh objects). A drift baseline captured from these must not alias the
    // live roster — else a later mutation would silently move the baseline too.
    return [...this.states.values()].map((s) => ({ ...s }))
  }

  activeParticipants(): MockParticipant[] {
    return [...this.states.values()].filter((s) => s.active).map((s) => new MockParticipant(s as any))
  }

  async reset(states: PersonaState[]) {
    this.resetCalled = true
    this.lastResetStates = states
    this.states.clear()
    // Store COPIES, like the real Registry (reset builds fresh Participant
    // objects from the incoming states). The caller's array — which the room
    // also keeps as its drift baseline — must stay independent of live state.
    for (const s of states) {
      this.states.set(s.id, { ...s })
    }
  }

  broadcastRoster() {}
  broadcastSettings() {}
  disposeAll() { this.states.clear() }
  onChange?: () => void
  onSystemNote?: (text: string) => void
  // No-op setters the real Registry exposes; applyConversation calls these
  // unconditionally, so the reload path needs them present (test-only stubs).
  setSessionRoot(_root: string | null) {}
  setHandoffGates(_gates: unknown[]) {}
  setDefaultThinkingLevel(_level: string) {}
  setAllowCloud(_allow: boolean) {}
  setCompactionReserveTokens(_n: number) {}
  setGoalEvaluator(_id: string) {}
}

class MockStore {
  savedConversations: any[] = []

  async init() {}
  async list() { return [] }
  async read(_id: string) { return null }
  async write(conv: any) { this.savedConversations.push(conv) }
  async remove(_id: string) {}
}

interface RosterEvent { items: any[] }
interface ConversationEvent { currentId: string; list: any[] }

class EventCapture {
  rosterEvents: RosterEvent[] = []
  conversationEvents: ConversationEvent[] = []
  settingsEvents: Record<string, unknown>[] = []

  constructor(private hub: SseHub) {
    const orig = hub.broadcast.bind(hub)
    hub.broadcast = (event, data) => {
      if (event === "roster") this.rosterEvents.push(data as RosterEvent)
      if (event === "conversations") this.conversationEvents.push(data as ConversationEvent)
      if (event === "settings") this.settingsEvents.push(data as Record<string, unknown>)
      orig(event, data)
    }
  }
}

function makePersona(id: string, name?: string): Persona {
  return { id, name: name || id, color: "#000", icon: "🤖", tools: [], systemPrompt: "" }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("applyPreset — in-place roster swap", () => {
  let registry: MockRegistry
  let hub: SseHub
  let store: MockStore
  let room: Room
  let events: EventCapture

  const initialPersonas = [makePersona("scout"), makePersona("builder")]

  beforeEach(async () => {
    hub = new SseHub(1)
    store = new MockStore()
    registry = new MockRegistry(initialPersonas)
    events = new EventCapture(hub)
    room = new Room(registry as any, hub, store as any, [])
    // Initialize room with a conversation
    await (room as any).startFresh("Test Discussion", initialPersonas.map(p => ({
      ...p, active: true, parallel: false, systemPrompt: "", tools: []
    })))
    // Post a message so transcript is not empty
    const post = (Room.prototype as any).post.bind(room)
    post("user", "User", "Hello world")
  })

  afterEach(async () => {
    ;(room as any).running = new Set()
    await room.abortCurrent()
  })

  test("applyPreset replaces roster without changing convId", async () => {
    const originalConvId = (room as any).convId
    const originalConvTitle = (room as any).convTitle

    const newPersonas = [
      { id: "planner", name: "Planner", color: "#4A90D9", icon: "📋", tools: ["read"], model: undefined, systemPrompt: "", active: true, parallel: false },
      { id: "auditor", name: "Auditor", color: "#D94A4A", icon: "🔬", tools: ["read"], model: undefined, systemPrompt: "", active: true, parallel: false },
    ]

    const result = await (room as any).applyPreset(newPersonas)

    // ConvId and title unchanged
    expect((room as any).convId).toBe(originalConvId)
    expect((room as any).convTitle).toBe(originalConvTitle)

    // New roster applied
    expect(registry.resetCalled).toBe(true)
    expect(registry.lastResetStates).toEqual(newPersonas)
    expect(registry.has("scout")).toBe(false)
    expect(registry.has("planner")).toBe(true)
    expect(registry.has("auditor")).toBe(true)

    // Result has the same convId
    expect(result.id).toBe(originalConvId)
  })

  test("applyPreset preserves transcript", async () => {
    const transcriptBefore = (room as any).transcript
    expect(transcriptBefore.length).toBe(1)
    expect(transcriptBefore[0].text).toBe("Hello world")

    const newPersonas = [
      { id: "planner", name: "Planner", color: "#4A90D9", icon: "📋", tools: [], model: undefined, systemPrompt: "", active: true, parallel: false },
    ]

    await (room as any).applyPreset(newPersonas)

    const transcriptAfter = (room as any).transcript
    expect(transcriptAfter.length).toBe(1)
    expect(transcriptAfter[0].text).toBe("Hello world")
    expect(transcriptAfter[0].author).toBe("user")
  })

  test("applyPreset persists via saveCurrent", async () => {
    const newPersonas = [
      { id: "planner", name: "Planner", color: "#4A90D9", icon: "📋", tools: [], model: undefined, systemPrompt: "", active: true, parallel: false },
    ]

    await (room as any).applyPreset(newPersonas)

    // Store should have been written
    expect(store.savedConversations.length).toBeGreaterThan(0)
    // The last save should have the new personas
    const lastSave = store.savedConversations[store.savedConversations.length - 1]
    expect(lastSave.personas.map((p: any) => p.id)).toContain("planner")
    expect(lastSave.personas.map((p: any) => p.id)).not.toContain("scout")
  })

  test("applyPreset keeps the same convId after persistence", async () => {
    const originalConvId = (room as any).convId

    const newPersonas = [
      { id: "planner", name: "Planner", color: "#4A90D9", icon: "📋", tools: [], model: undefined, systemPrompt: "", active: true, parallel: false },
    ]

    await (room as any).applyPreset(newPersonas)

    // The saved conversation should have the same convId
    const lastSave = store.savedConversations[store.savedConversations.length - 1]
    expect(lastSave.id).toBe(originalConvId)
  })

  test("applyPreset with model assignments preserves them", async () => {
    const newPersonas = [
      { id: "planner", name: "Planner", color: "#4A90D9", icon: "📋", tools: [], model: "anthropic/claude-opus-4-6-20250603", systemPrompt: "", active: true, parallel: false },
      { id: "builder", name: "Builder", color: "#06B6D4", icon: "🔨", tools: [], model: "deepseek/deepseek-chat", systemPrompt: "", active: true, parallel: true },
    ]

    await (room as any).applyPreset(newPersonas)

    const lastSave = store.savedConversations[store.savedConversations.length - 1]
    const planner = lastSave.personas.find((p: any) => p.id === "planner")
    const builder = lastSave.personas.find((p: any) => p.id === "builder")
    expect(planner.model).toBe("anthropic/claude-opus-4-6-20250603")
    expect(builder.model).toBe("deepseek/deepseek-chat")
    expect(builder.parallel).toBe(true)
  })

  test("applyPreset rejects when busy", async () => {
    // Simulate busy state — ensureIdle checks running.size
    ;(room as any).running = new Set(["scout"])

    const newPersonas = [
      { id: "planner", name: "Planner", color: "#4A90D9", icon: "📋", tools: [], model: undefined, systemPrompt: "", active: true, parallel: false },
    ]

    await expect((room as any).applyPreset(newPersonas)).rejects.toThrow("a turn is running")
  })

  test("applyPreset broadcasts conversations", async () => {
    const newPersonas = [
      { id: "planner", name: "Planner", color: "#4A90D9", icon: "📋", tools: [], model: undefined, systemPrompt: "", active: true, parallel: false },
    ]

    await (room as any).applyPreset(newPersonas)

    expect(events.conversationEvents.length).toBeGreaterThan(0)
  })
})

describe("applyPreset vs loadPreset — behavioral difference", () => {
  let registry: MockRegistry
  let hub: SseHub
  let store: MockStore
  let room: Room

  const initialPersonas = [makePersona("scout"), makePersona("builder")]

  beforeEach(async () => {
    hub = new SseHub(1)
    store = new MockStore()
    registry = new MockRegistry(initialPersonas)
    room = new Room(registry as any, hub, store as any, [])
    await (room as any).startFresh("Original Discussion", initialPersonas.map(p => ({
      ...p, active: true, parallel: false, systemPrompt: "", tools: []
    })))
    const post = (Room.prototype as any).post.bind(room)
    post("user", "User", "Original message")
  })

  afterEach(async () => {
    await room.abortCurrent()
  })

  test("loadPreset creates a new conversation (different convId)", async () => {
    const originalConvId = (room as any).convId

    const newPersonas = [
      { id: "planner", name: "Planner", color: "#4A90D9", icon: "📋", tools: [], model: undefined, systemPrompt: "", active: true, parallel: false },
    ]

    await (room as any).loadPreset(newPersonas, "Preset Discussion")

    // ConvId changed
    expect((room as any).convId).not.toBe(originalConvId)
    // Transcript cleared
    expect((room as any).transcript.length).toBe(0)
  })

  test("applyPreset keeps the same conversation (same convId)", async () => {
    const originalConvId = (room as any).convId

    const newPersonas = [
      { id: "planner", name: "Planner", color: "#4A90D9", icon: "📋", tools: [], model: undefined, systemPrompt: "", active: true, parallel: false },
    ]

    await (room as any).applyPreset(newPersonas)

    // ConvId unchanged
    expect((room as any).convId).toBe(originalConvId)
    // Transcript preserved
    expect((room as any).transcript.length).toBe(1)
    expect((room as any).transcript[0].text).toBe("Original message")
  })

  test("loadPreset clears transcript", async () => {
    await (room as any).loadPreset([
      { id: "planner", name: "Planner", color: "#4A90D9", icon: "📋", tools: [], model: undefined, systemPrompt: "", active: true, parallel: false },
    ], "New")

    expect((room as any).transcript.length).toBe(0)
  })

  test("applyPreset preserves transcript", async () => {
    await (room as any).applyPreset([
      { id: "planner", name: "Planner", color: "#4A90D9", icon: "📋", tools: [], model: undefined, systemPrompt: "", active: true, parallel: false },
    ])

    expect((room as any).transcript.length).toBe(1)
    expect((room as any).transcript[0].text).toBe("Original message")
  })
})

// ── Preset drift wiring (« line-up ≠ preset ») ──────────────────────────────

describe("preset drift — provenance, dormancy, latch", () => {
  let registry: MockRegistry
  let hub: SseHub
  let store: MockStore
  let room: Room

  // Non-seed ids so stripSeedFields is a no-op and drift is a direct diff.
  const roster = [
    { id: "c1", name: "C1", color: "#000", icon: "🤖", tools: ["read"], model: undefined, systemPrompt: "", active: true, parallel: false },
    { id: "c2", name: "C2", color: "#000", icon: "🤖", tools: ["read"], model: undefined, systemPrompt: "", active: true, parallel: false },
  ]
  const clone = () => roster.map((p) => ({ ...p }))

  beforeEach(async () => {
    hub = new SseHub(1)
    store = new MockStore()
    registry = new MockRegistry([])
    room = new Room(registry as any, hub, store as any, [])
  })

  afterEach(async () => {
    await room.abortCurrent()
  })

  test("an ad-hoc room (no sourcePreset) is dormant — getDrift() is null", async () => {
    await (room as any).startFresh("Ad-hoc", clone())
    expect(room.getDrift()).toBeNull()
    // …and buildConversation carries no sourcePreset field.
    expect((room as any).buildConversation().sourcePreset).toBeUndefined()
  })

  test("applyPreset with a name stamps provenance and reads zero drift", async () => {
    await (room as any).startFresh("Seed", clone())
    await (room as any).applyPreset(clone(), "team-x")
    const drift = room.getDrift()
    expect(drift).toEqual({ preset: "team-x", deviates: false })
    expect((room as any).buildConversation().sourcePreset).toBe("team-x")
  })

  // Mutate the STORED live state (personaStates now returns copies).
  const fuse = (id: string) => { ((registry as any).states.get(id) as any).seat = "shared" }
  const defuse = (id: string) => { delete ((registry as any).states.get(id) as any).seat }
  const setModel = (id: string, m: string) => { ((registry as any).states.get(id) as any).model = m }

  test("a roster edit after applyPreset flips drift and posts ONE deviation line", async () => {
    await (room as any).applyPreset(clone(), "team-x")
    // Simulate a fuse: mutate the live roster, then the onChange → evaluateDrift.
    fuse("c1")
    ;(room as any).evaluateDrift()

    expect(room.getDrift()).toEqual({ preset: "team-x", deviates: true })
    const lines = (room as any).transcript.filter(
      (e: any) => e.author === "system" && e.text.includes("deviates from preset"),
    )
    expect(lines.length).toBe(1)
    expect(lines[0].text).toContain("team-x")
  })

  test("the latch does not re-fire while the roster stays deviated", async () => {
    await (room as any).applyPreset(clone(), "team-x")
    fuse("c1")
    ;(room as any).evaluateDrift()
    // A second unrelated edit while still deviated.
    setModel("c2", "anthropic/opus")
    ;(room as any).evaluateDrift()

    const lines = (room as any).transcript.filter(
      (e: any) => e.author === "system" && e.text.includes("deviates from preset"),
    )
    expect(lines.length).toBe(1) // still exactly one
  })

  test("returning the roster to the preset clears drift and re-arms the latch", async () => {
    await (room as any).applyPreset(clone(), "team-x")
    fuse("c1")
    ;(room as any).evaluateDrift()
    expect(room.getDrift()?.deviates).toBe(true)

    // Restore: remove the seat → back to the preset baseline.
    defuse("c1")
    ;(room as any).evaluateDrift()
    expect(room.getDrift()?.deviates).toBe(false)

    // Re-armed: a fresh deviation posts a second line.
    fuse("c1")
    ;(room as any).evaluateDrift()
    const lines = (room as any).transcript.filter(
      (e: any) => e.author === "system" && e.text.includes("deviates from preset"),
    )
    expect(lines.length).toBe(2)
  })

  test("rebaselineToCurrentRoster (/preset push) adopts the live roster and clears drift", async () => {
    await (room as any).applyPreset(clone(), "team-x")
    fuse("c1")
    ;(room as any).evaluateDrift()
    expect(room.getDrift()?.deviates).toBe(true)

    // Push: the live (fused) roster becomes the new baseline, persisted.
    const savesBefore = store.savedConversations.length
    await room.rebaselineToCurrentRoster()
    expect(room.getDrift()).toEqual({ preset: "team-x", deviates: false })
    expect(store.savedConversations.length).toBeGreaterThan(savesBefore) // persisted before returning

    // Latch re-armed: a NEW deviation posts a fresh line.
    setModel("c2", "anthropic/opus")
    ;(room as any).evaluateDrift()
    const lines = (room as any).transcript.filter(
      (e: any) => e.author === "system" && e.text.includes("deviates from preset"),
    )
    expect(lines.length).toBe(2)
  })

  test("rebaselineToCurrentRoster is a no-op on an ad-hoc room", async () => {
    await (room as any).startFresh("Ad-hoc", clone())
    await room.rebaselineToCurrentRoster()
    expect(room.getDrift()).toBeNull()
  })

  test("getSourcePreset — null when ad-hoc, the name once stamped", async () => {
    await (room as any).startFresh("Ad-hoc", clone())
    expect(room.getSourcePreset()).toBeNull()
    await (room as any).applyPreset(clone(), "team-x")
    expect(room.getSourcePreset()).toBe("team-x")
  })

  test("adoptPresetProvenance stamps a room born from a preset (the provisionRoom path)", async () => {
    // Simulate provisionRoom: init startFresh'd the roster and cleared provenance.
    await (room as any).startFresh("born-from-preset", clone())
    expect(room.getDrift()).toBeNull() // dormant right after init

    const savesBefore = store.savedConversations.length
    await room.adoptPresetProvenance("team-x", clone())
    expect(room.getDrift()).toEqual({ preset: "team-x", deviates: false })
    expect((room as any).buildConversation().sourcePreset).toBe("team-x")
    expect(store.savedConversations.length).toBeGreaterThan(savesBefore) // persisted

    // …and drift now tracks live edits on the born-with roster.
    fuse("c1")
    ;(room as any).evaluateDrift()
    expect(room.getDrift()?.deviates).toBe(true)
  })

  test("a room BORN from a preset with an inactive agent does NOT false-drift (tester 2026-07-12)", async () => {
    // Reproduce provisionRoom: the room's SEED is the preset roster, one agent
    // inactive. init() must honor that active:false, not force-activate it —
    // else baseline(preset) ≠ live(force-activated) = instant drift at birth.
    const presetRoster = [
      { id: "planner", name: "P", color: "#000", icon: "🤖", tools: ["read"], model: undefined, systemPrompt: "", active: true, parallel: false },
      { id: "scribe", name: "S", color: "#000", icon: "🤖", tools: ["read"], model: undefined, systemPrompt: "", active: false, parallel: false },
    ]
    const bornStore = new MockStore()
    const bornRegistry = new MockRegistry([])
    const bornRoom = new Room(bornRegistry as any, hub, bornStore as any, presetRoster as any)
    await bornRoom.init() // no saved conv → startFresh(seedRoster()) honoring active flags
    await bornRoom.adoptPresetProvenance("team-x", presetRoster as any)

    // The whole point: zero drift at birth despite the inactive scribe.
    expect(bornRoom.getDrift()).toEqual({ preset: "team-x", deviates: false })
    // …and scribe stayed inactive (not force-activated).
    const scribe = bornRegistry.personaStates().find((p) => p.id === "scribe")
    expect(scribe?.active).toBe(false)

    await bornRoom.abortCurrent()
  })

  test("loadPreset persists sourcePreset SYNCHRONOUSLY before returning (auditor 2026-07-12)", async () => {
    await (room as any).loadPreset(clone(), "New disc", "team-x")
    // The LAST snapshot on disk must already carry provenance — not a later
    // void save. A crash right after the HTTP 200 must not restore it ad-hoc.
    const last = store.savedConversations[store.savedConversations.length - 1]
    expect(last.sourcePreset).toBe("team-x")
    expect(room.getDrift()).toEqual({ preset: "team-x", deviates: false })
  })

  test("reload of a loadPreset snapshot restores provenance + recomputes drift via presetReader", async () => {
    room.setPresetReader(async (name) => (name === "team-x" ? clone() : null))
    await (room as any).loadPreset(clone(), "New disc", "team-x")
    const snap = JSON.parse(JSON.stringify(store.savedConversations[store.savedConversations.length - 1]))
    expect(snap.sourcePreset).toBe("team-x")

    // Simulate a pre-crash deviation baked into the saved roster.
    snap.personas.find((p: any) => p.id === "c1").seat = "shared"

    // Reboot path: apply the saved snapshot; presetReader rebuilds the baseline
    // and drift is recomputed against the SAVED (deviated) roster.
    await (room as any).applyConversation(snap)
    expect(room.getSourcePreset()).toBe("team-x")
    expect(room.getDrift()).toEqual({ preset: "team-x", deviates: true })
  })

  test("transcript images count at pi's weight (~1200 tok each), never zero (auditor 2026-07-13)", async () => {
    await (room as any).init()
    // An image-ONLY entry (empty text) must not be skipped: pi weighs each image
    // at ESTIMATED_IMAGE_CHARS=4800 → 1200 tokens. Text-only wrapping undercounted.
    ;(room as any).post("user", "You", "", undefined, undefined, ["media/a.png"])
    expect((room as any).getRoomUsage().tokens).toBe(1200)
    // Two more images → +2400.
    ;(room as any).post("user", "You", "", undefined, undefined, ["media/b.png", "media/c.png"])
    expect((room as any).getRoomUsage().tokens).toBe(3600)
  })

  test("/compact does NOT move the room gauge — shared transcript unchanged (dax 2026-07-13)", async () => {
    await (room as any).init()
    await registry.reset([{ id: "builder", active: true } as any])
    ;(room as any).post("user", "You", "x".repeat(400))
    const before = (room as any).getRoomUsage()
    expect(before.tokens).toBeGreaterThan(0)
    expect(before.hotPercent).toBeNull() // v1: absolute only, no percent

    // Compacting a seat's PERSONAL session must leave the GROUP transcript — and
    // therefore the room gauge — exactly where it was. That's the whole point of
    // the redefinition: personal context ≠ group context.
    const ok = await (room as any).compactParticipant("builder")
    expect(ok.ok).toBe(true)
    expect((room as any).getRoomUsage()).toEqual(before)
  })

  test("compactParticipant broadcasts the ROSTER (per-agent gauge), never the room settings (dax 2026-07-13)", async () => {
    await (room as any).init()
    await registry.reset([{ id: "builder", active: true } as any])
    let rosterCalls = 0
    ;(registry as any).broadcastRoster = () => { rosterCalls++ }

    const ok = await (room as any).compactParticipant("builder")
    expect(ok.ok).toBe(true)
    expect(ok.result.tokensBefore).toBe(999)
    // The PERSONAL context shrank → refresh the per-agent roster gauge, not the
    // room `ctx:` (which tracks the untouched transcript).
    expect(rosterCalls).toBe(1)

    // Unknown participant → no compaction, no roster broadcast.
    rosterCalls = 0
    const bad = await (room as any).compactParticipant("ghost")
    expect(bad).toEqual({ ok: false, reason: "unknown", message: 'unknown participant "ghost"' })
    expect(rosterCalls).toBe(0)
  })

  test("roomUsage = shared transcript (grows with the conversation), refreshed on a mutation (dax 2026-07-13)", async () => {
    const cap = new EventCapture(hub)
    await (room as any).init()
    ;(room as any).post("user", "You", "hello ".repeat(100))
    cap.settingsEvents.length = 0

    // A roster mutation fires onChange → broadcastSettings; roomUsage reflects the
    // shared transcript, NOT a per-seat sum, and carries no percent in v1.
    registry.onChange!()
    const ev = cap.settingsEvents.at(-1)
    expect((ev?.roomUsage as any).tokens).toBeGreaterThan(0)
    expect((ev?.roomUsage as any).hotPercent).toBeNull()
    const t1 = (ev?.roomUsage as any).tokens

    // Grow the transcript → the next refresh reflects the bigger shared log.
    ;(room as any).post("user", "You", "more ".repeat(500))
    registry.onChange!()
    expect((cap.settingsEvents.at(-1)?.roomUsage as any).tokens).toBeGreaterThan(t1)
  })

  test("applyPreset without a name leaves the room dormant", async () => {
    await (room as any).applyPreset(clone())
    expect(room.getDrift()).toBeNull()
    ;((registry as any).states.get("c1") as any).seat = "shared"
    ;(room as any).evaluateDrift()
    expect(room.getDrift()).toBeNull()
  })
})
