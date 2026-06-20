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
  cursor = 0

  constructor(persona: Persona) {
    this.persona = persona
  }

  // Stub — never called in our test path
  run(_ctx: { text: string; images?: string[] }): Promise<{
    reply: string
    activity: unknown[]
    reasoning?: string
    question?: string
    receipt: WorkReceipt
  }> {
    return Promise.reject(new Error("not implemented"))
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

interface CbEvent { agentId: string; agentName: string; count: number }
interface NoticeEvent { msg: string; level: string }

class EventCapture {
  notices: NoticeEvent[] = []
  circuitBreaker: CbEvent | null = null

  constructor(private hub: SseHub) {
    const orig = hub.broadcast.bind(hub)
    hub.broadcast = (event, data) => {
      if (event === "notice") {
        this.notices.push(data as NoticeEvent)
      }
      if (event === "circuit_breaker") {
        this.circuitBreaker = data as CbEvent
      }
      orig(event, data)
    }
  }
}

function makePersona(id: string): Persona {
  return { id, name: id, color: "#000", icon: "🤖", tools: [], systemPrompt: "" }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("circuit breaker — integration", () => {
  let registry: MockRegistry
  let hub: SseHub
  let store: MockStore
  let room: Room
  let events: EventCapture

  beforeEach(() => {
    hub = new SseHub(1)
    store = new MockStore()
    registry = new MockRegistry()
    events = new EventCapture(hub)
    room = new Room(registry as any, hub, store as any, [])
  })

  afterEach(async () => {
    await room.abortCurrent()
  })

  /**
   * Access the private `post` method via reflection.
   * This is the only way to test the circuit breaker in post()
   * without running a full agent through the drain loop.
   */
  function postAs(room: Room, author: string, authorName: string, text: string) {
    const post = (Room.prototype as any).post.bind(room)
    post(author, authorName, text)
  }

  test("circuit breaker triggers after 5 identical agent messages", () => {
    const repeated = "I am stuck in a loop doing the same thing"

    for (let i = 0; i < 5; i++) {
      postAs(room, "builder", "Builder", repeated)
    }

    // Circuit breaker should have fired on the 5th message
    expect(events.circuitBreaker).not.toBeNull()
    expect(events.circuitBreaker!.count).toBe(5)

    // Notice should be an error-level message
    const cbNotice = events.notices.find((n) => n.msg.includes("Circuit breaker"))
    expect(cbNotice).toBeDefined()
    expect(cbNotice!.level).toBe("error")

    // Transcript should have 5 entries
    const transcript = room.getTranscript()
    expect(transcript.length).toBe(5)
  })

  test("does NOT trigger with different agent messages", () => {
    const messages = [
      "I did step 1 of the task",
      "I did step 2 of the task",
      "I did step 3 of the task",
      "I did step 4 of the task",
      "I did step 5 of the task",
    ]

    for (const msg of messages) {
      postAs(room, "builder", "Builder", msg)
    }

    expect(events.circuitBreaker).toBeNull()
  })

  test("does NOT trigger for user messages", () => {
    const repeated = "I am stuck in a loop"

    for (let i = 0; i < 10; i++) {
      postAs(room, "user", "You", repeated)
    }

    expect(events.circuitBreaker).toBeNull()
  })

  test("triggers exactly at threshold — 4 messages is not enough, 5 is", () => {
    const repeated = "I am stuck in a loop"

    // 4 messages — no trigger
    for (let i = 0; i < 4; i++) {
      postAs(room, "builder", "Builder", repeated)
    }
    expect(events.circuitBreaker).toBeNull()

    // 5th message — triggers
    postAs(room, "builder", "Builder", repeated)
    expect(events.circuitBreaker).not.toBeNull()
  })

  test("near-identical messages (above similarity floor) trigger the breaker", () => {
    // 14 unique words, 13 common → 13/15 ≈ 0.867 > 0.8
    const base = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike time"
    const variant = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike day"

    // Post 4 base messages + 1 variant = 5 similar
    for (let i = 0; i < 4; i++) {
      postAs(room, "builder", "Builder", base)
    }
    expect(events.circuitBreaker).toBeNull()

    postAs(room, "builder", "Builder", variant)
    expect(events.circuitBreaker).not.toBeNull()
  })

  test("mixed authors — only same-author messages count", () => {
    const repeated = "I am stuck in a loop"

    // Interleave two different agents
    for (let i = 0; i < 4; i++) {
      postAs(room, "builder", "Builder", repeated)
      postAs(room, "auditor", "Auditor", repeated)
    }

    // Each agent only has 4 messages — no trigger
    expect(events.circuitBreaker).toBeNull()

    // 5th message from builder — triggers
    postAs(room, "builder", "Builder", repeated)
    expect(events.circuitBreaker).not.toBeNull()
    expect(events.circuitBreaker!.agentId).toBe("builder")
  })
})
