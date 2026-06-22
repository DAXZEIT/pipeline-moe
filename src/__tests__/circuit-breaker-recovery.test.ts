import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
import type { Persona, PersonaState, WorkReceipt } from "../types.js"

// ── Mocks ────────────────────────────────────────────────────────────────

class MockParticipant {
  persona: Persona
  active = true
  parallel = false
  status: "idle" | "active" | "thinking" | "working" = "idle"
  customMessages: Array<{ customType: string; content: string }> = []

  constructor(persona: Persona) {
    this.persona = persona
  }

  async run(_ctx: { text: string; images?: string[] }): Promise<{
    reply: string
    activity: unknown[]
    reasoning?: string
    question?: string
    receipt: WorkReceipt
  }> {
    return {
      reply: "OK",
      activity: [],
      receipt: { participantId: this.persona.id, created: [], modified: [], deleted: [] },
    }
  }

  sendCustomMessage(msg: { customType: string; content: string; display: boolean }, _opts: any) {
    this.customMessages.push({ customType: msg.customType, content: msg.content })
    return Promise.resolve()
  }
}

class MockRegistry {
  private participants = new Map<string, MockParticipant>()

  has(id: string): boolean {
    return this.participants.has(id)
  }

  get(id: string): MockParticipant | undefined {
    return this.participants.get(id)
  }

  addParticipant(p: MockParticipant) {
    this.participants.set(p.persona.id, p)
  }

  personaStates(): PersonaState[] {
    return [...this.participants.values()].map((p) => ({
      ...p.persona,
      active: p.active,
      parallel: p.parallel,
    }))
  }

  activeParticipants(): MockParticipant[] {
    return [...this.participants.values()].filter((p) => p.active)
  }

  reset(_states: PersonaState[]) {}
  disposeAll() { this.participants.clear() }
}

class MockStore {
  async init() {}
  async list() { return [] }
  async read(_id: string) { return null }
  async write(_conv: any) {}
  async remove(_id: string) {}
}

function makePersona(id: string): Persona {
  return { id, name: id, color: "#000", icon: "🤖", tools: [], systemPrompt: "" }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("circuit breaker — recovery routing", () => {
  let registry: MockRegistry
  let hub: SseHub
  let store: MockStore
  let room: Room

  beforeEach(() => {
    hub = new SseHub(1)
    store = new MockStore()
    registry = new MockRegistry()
    room = new Room(registry as any, hub, store as any, [])
  })

  afterEach(async () => {
    await room.abortCurrent()
  })

  /** Access private methods via reflection. */
  const getAborted = (r: Room) => (r as any).aborted
  const getCircuitBreakerAgentId = (r: Room) => (r as any).circuitBreakerAgentId
  const getFallbackAgentId = (r: Room) => (r as any).fallbackAgentId
  const setFallbackAgentId = (r: Room, id: string | null) => { (r as any).fallbackAgentId = id }
  const post = (r: Room, author: string, authorName: string, text: string) => {
    const postMethod = (Room.prototype as any).post.bind(r)
    postMethod(author, authorName, text)
  }

  test("circuit breaker sets circuitBreakerAgentId on the looping agent", () => {
    const repeated = "I am stuck in a loop"

    for (let i = 0; i < 5; i++) {
      post(room, "builder", "Builder", repeated)
    }

    expect(getCircuitBreakerAgentId(room)).toBe("builder")
    expect(getAborted(room)).toBe(true)
  })

  test("circuitBreakerAgentId is reset at the start of a new turn", () => {
    // Simulate a new turn starting
    setFallbackAgentId(room, null)
    ;(room as any).aborted = false
    ;(room as any).circuitBreakerAgentId = "builder"

    // Simulate the reset that happens at the start of sendMessage
    ;(room as any).aborted = false
    ;(room as any).circuitBreakerAgentId = null

    expect(getCircuitBreakerAgentId(room)).toBeNull()
  })

  test("fallback agent is not the looping agent — recovery is possible", () => {
    const looping = registry.addParticipant(new MockParticipant(makePersona("builder")))
    const fallback = registry.addParticipant(new MockParticipant(makePersona("planner")))
    setFallbackAgentId(room, "planner")

    const repeated = "I am stuck in a loop"
    for (let i = 0; i < 5; i++) {
      post(room, "builder", "Builder", repeated)
    }

    expect(getCircuitBreakerAgentId(room)).toBe("builder")
    expect(getFallbackAgentId(room)).toBe("planner")
    expect(getCircuitBreakerAgentId(room) !== getFallbackAgentId(room)).toBe(true)
  })

  test("fallback agent IS the looping agent — no recovery possible", () => {
    registry.addParticipant(new MockParticipant(makePersona("planner")))
    setFallbackAgentId(room, "planner")

    const repeated = "I am stuck in a loop"
    for (let i = 0; i < 5; i++) {
      post(room, "planner", "Planner", repeated)
    }

    expect(getCircuitBreakerAgentId(room)).toBe("planner")
    expect(getFallbackAgentId(room)).toBe("planner")
    expect(getCircuitBreakerAgentId(room) === getFallbackAgentId(room)).toBe(true)
  })

  test("no fallback configured — circuit breakerAgentId still recorded", () => {
    setFallbackAgentId(room, null)

    const repeated = "I am stuck in a loop"
    for (let i = 0; i < 5; i++) {
      post(room, "builder", "Builder", repeated)
    }

    expect(getCircuitBreakerAgentId(room)).toBe("builder")
    expect(getFallbackAgentId(room)).toBeNull()
  })
})
