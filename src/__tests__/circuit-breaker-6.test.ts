import { describe, expect, test, beforeEach, afterEach } from "vitest"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
import type { Persona } from "../types.js"

class MockParticipant {
  persona: Persona
  active = true
  parallel = false
  status: "idle" | "active" | "thinking" | "working" = "idle"
  cursor = 0
  constructor(persona: Persona) { this.persona = persona }
  async run() { throw new Error("noop") }
}

class MockRegistry {
  private p = new Map<string, MockParticipant>()
  has(id: string) { return this.p.has(id) }
  get(id: string) { return this.p.get(id) }
  addParticipant(p: MockParticipant) { this.p.set(p.persona.id, p) }
  personaStates() { return [...this.p.values()].map(p => ({...p.persona, active: p.active, parallel: p.parallel})) }
  activeParticipants() { return [...this.p.values()] }
  reset() {}
  disposeAll() { this.p.clear() }
}

class MockStore {
  async init() {}
  async list() { return [] }
  async read() { return null }
  async write() {}
  async remove() {}
}

function makePersona(id: string): Persona {
  return { id, name: id, color: "#000", icon: "🤖", tools: [], systemPrompt: "" }
}

function postAs(room: Room, author: string, name: string, text: string) {
  const post = (Room.prototype as any).post.bind(room)
  post(author, name, text)
}

function getAborted(room: Room): boolean {
  return (room as any).aborted
}

describe("circuit breaker — 6 repetitions", () => {
  let room: Room
  let cbEvent: any = null
  let noticeEvents: any[] = []

  beforeEach(() => {
    const hub = new SseHub(1)
    const orig = hub.broadcast.bind(hub)
    hub.broadcast = (event, data) => {
      if (event === "circuit_breaker") cbEvent = data
      if (event === "notice") noticeEvents.push(data)
      orig(event, data)
    }
    const registry = new MockRegistry()
    registry.addParticipant(new MockParticipant(makePersona("builder")))
    const store = new MockStore()
    room = new Room(registry as any, hub, store as any, [])
  })

  afterEach(async () => { await room.abortCurrent() })

  test("6 identical messages — triggers on 5th, 6th is posted but room already aborted", () => {
    const repeated = "je suis bloqué dans une boucle infinie"

    // Post 1-4: no trigger
    for (let i = 0; i < 4; i++) {
      postAs(room, "builder", "Builder", repeated)
    }
    expect(cbEvent).toBeNull()
    expect(getAborted(room)).toBe(false)

    // Post 5: triggers
    postAs(room, "builder", "Builder", repeated)
    expect(cbEvent).not.toBeNull()
    expect(cbEvent.count).toBe(5)
    expect(getAborted(room)).toBe(true)

    // Post 6: room already aborted, but post() still adds to transcript
    postAs(room, "builder", "Builder", repeated)
    const transcript = room.getTranscript()
    expect(transcript.length).toBe(6)
  })

  test("trigger fires at exactly 5 — boundary confirmed with error notice", () => {
    const repeated = "phrase répétée encore et encore"

    for (let i = 0; i < 5; i++) {
      postAs(room, "builder", "Builder", repeated)
    }

    expect(cbEvent).not.toBeNull()
    expect(cbEvent.count).toBe(5)

    const notice = noticeEvents.find(n => n.msg.includes("Circuit breaker"))
    expect(notice).toBeDefined()
    expect(notice.level).toBe("error")
  })
})
