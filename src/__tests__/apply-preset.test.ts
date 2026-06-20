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
    return new MockParticipant(s as any)
  }

  personaStates(): PersonaState[] {
    return [...this.states.values()]
  }

  activeParticipants(): MockParticipant[] {
    return [...this.states.values()].filter((s) => s.active).map((s) => new MockParticipant(s as any))
  }

  async reset(states: PersonaState[]) {
    this.resetCalled = true
    this.lastResetStates = states
    this.states.clear()
    for (const s of states) {
      this.states.set(s.id, s)
    }
  }

  broadcastRoster() {}
  broadcastSettings() {}
  disposeAll() { this.states.clear() }
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

  constructor(private hub: SseHub) {
    const orig = hub.broadcast.bind(hub)
    hub.broadcast = (event, data) => {
      if (event === "roster") this.rosterEvents.push(data as RosterEvent)
      if (event === "conversations") this.conversationEvents.push(data as ConversationEvent)
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
