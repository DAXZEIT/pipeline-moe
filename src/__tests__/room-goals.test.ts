import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Room } from "../room.js"
import { RoomManager } from "../room-manager.js"
import { SseHub } from "../sse.js"
import { REPEAT_THRESHOLD } from "../circuit-breaker.js"
import type { Persona, PersonaState } from "../types.js"

// ── Mocks ────────────────────────────────────────────────────────────────────

class MockParticipant {
  persona: Persona
  active = true
  parallel = false
  status: "idle" | "active" | "thinking" | "working" = "idle"
  cursor = 0
  private _reply: string

  constructor(persona: Persona, reply = "(done)") {
    this.persona = persona
    this._reply = reply
  }

  async run(_text: string) {
    return { text: this._reply, activity: [], reasoning: undefined, question: undefined }
  }

  async followUp(_text: string) { return this.run(_text) }

  getContextUsage() { return undefined }
  getSessionStats() { return undefined }
  getAvailableThinkingLevels() { return [] }
}

class MockRegistry {
  private parts = new Map<string, MockParticipant>()
  onChange: (() => void) | null = null

  add(p: MockParticipant) { this.parts.set(p.persona.id, p) }
  get(id: string) { return this.parts.get(id) }
  has(id: string) { return this.parts.has(id) }
  roster() {
    return [...this.parts.values()].map(p => ({
      id: p.persona.id, name: p.persona.name, color: p.persona.color,
      icon: p.persona.icon, tools: p.persona.tools, active: p.active,
      status: p.status, parallel: p.parallel,
    }))
  }
  activeParticipants() { return [...this.parts.values()].filter(p => p.active) }
  personaStates(): PersonaState[] {
    return [...this.parts.values()].map(p => ({ ...p.persona, active: p.active, parallel: p.parallel }))
  }
  broadcastRoster() {}
  reset(_states: any[]) {}
  setActive(id: string, active: boolean) {
    const p = this.parts.get(id); if (p) p.active = active
  }
  kick(id: string) { this.parts.delete(id) }
  disposeAll() { this.parts.clear() }
  isAllowedModel(_model: string) { return true }
}

class MockStore {
  async init() {}
  async write() {}
  async read() { return null }
  async list() { return [] }
  async remove(_id: string) {}
}

function makePersona(id: string): Persona {
  return { id, name: id, color: "#000", icon: "🤖", tools: [], systemPrompt: "" }
}

/** Access private Room fields/methods via reflection (test-only). */
const priv = (r: Room) => r as any
const post = (r: Room, author: string, name: string, text: string) => {
  (Room.prototype as any).post.call(r, author, name, text)
}

// ── Goal state machine tests ──────────────────────────────────────────────────

describe("Room goal state machine", () => {
  let registry: MockRegistry
  let hub: SseHub
  let store: MockStore
  let room: Room

  beforeEach(() => {
    hub = new SseHub(1)
    store = new MockStore()
    registry = new MockRegistry()
    room = new Room(registry as any, hub, store as any, [], "test-room")
  })

  afterEach(async () => {
    await room.abortCurrent()
  })

  test("initial state: goalText is null, goalStatus is idle", () => {
    expect(room.getGoalText()).toBeNull()
    expect(room.getGoalStatus()).toBe("idle")
  })

  test("submitGoal sets goalText and goalStatus to running", () => {
    // No participants — the turn will produce no agents, but state is set synchronously
    room.submitGoal("build a widget")
    expect(room.getGoalText()).toBe("build a widget")
    expect(room.getGoalStatus()).toBe("running")
  })

  test("goal reaches completed after natural turn end", async () => {
    const agent = new MockParticipant(makePersona("builder"), "(done — no further work needed)")
    registry.add(agent)
    await room.init()

    room.submitGoal("@builder do something")

    // Wait for async turn to complete.
    await new Promise<void>(resolve => setTimeout(resolve, 300))

    expect(room.getGoalStatus()).toBe("completed")
    expect(room.getGoalText()).toBe("@builder do something")
  })

  test("goal reaches failed when circuit breaker trips without recovery", async () => {
    const LOOPING_REPLY = "I am stuck looping and cannot stop this repetitive action"
    const agent = new MockParticipant(makePersona("builder"), LOOPING_REPLY)
    registry.add(agent)
    // Disable fallback so recovery doesn't fire.
    priv(room).fallbackAgentId = null
    await room.init()

    // Pre-populate transcript with (REPEAT_THRESHOLD - 1) identical messages
    // so the mock agent's first reply is the one that trips the breaker.
    for (let i = 0; i < REPEAT_THRESHOLD - 1; i++) {
      post(room, "builder", "Builder", LOOPING_REPLY)
    }

    room.submitGoal("@builder do something")

    // Wait for async turn — circuit breaker fires, turn ends, status should be failed.
    await new Promise<void>(resolve => setTimeout(resolve, 400))

    expect(room.getGoalStatus()).toBe("failed")
  })

  test("non-goal room: endTurn does not change goalStatus", async () => {
    const agent = new MockParticipant(makePersona("builder"), "(done)")
    registry.add(agent)
    await room.init()

    // Normal submit (not submitGoal) — goalText stays null.
    room.submit("@builder hello")
    await new Promise<void>(resolve => setTimeout(resolve, 300))

    expect(room.getGoalText()).toBeNull()
    expect(room.getGoalStatus()).toBe("idle")
  })

  test("goal-completed event is emitted when turn ends naturally", async () => {
    const events: Array<{ type: string; goalText?: string }> = []
    const origBroadcast = hub.broadcast.bind(hub)
    hub.broadcast = (event, data) => {
      if (event === "room") events.push(data as any)
      origBroadcast(event, data)
    }

    const agent = new MockParticipant(makePersona("builder"), "(all done)")
    registry.add(agent)
    await room.init()

    room.submitGoal("@builder finish the task")
    await new Promise<void>(resolve => setTimeout(resolve, 300))

    const completedEvent = events.find(e => e.type === "goal-completed")
    expect(completedEvent).toBeDefined()
    expect(completedEvent!.goalText).toBe("@builder finish the task")
  })

  test("goal-failed event is emitted when circuit breaker trips", async () => {
    const LOOPING_REPLY = "Same response over and over causing a loop in the system"
    const events: Array<{ type: string; goalText?: string }> = []
    const origBroadcast = hub.broadcast.bind(hub)
    hub.broadcast = (event, data) => {
      if (event === "room") events.push(data as any)
      origBroadcast(event, data)
    }

    const agent = new MockParticipant(makePersona("builder"), LOOPING_REPLY)
    registry.add(agent)
    priv(room).fallbackAgentId = null
    await room.init()

    for (let i = 0; i < REPEAT_THRESHOLD - 1; i++) {
      post(room, "builder", "Builder", LOOPING_REPLY)
    }

    room.submitGoal("@builder do something that loops")
    await new Promise<void>(resolve => setTimeout(resolve, 400))

    const failedEvent = events.find(e => e.type === "goal-failed")
    expect(failedEvent).toBeDefined()
    expect(failedEvent!.goalText).toBe("@builder do something that loops")
  })
})

// ── RoomManager goal integration ──────────────────────────────────────────────

describe("RoomManager — goal support", () => {
  let hub: SseHub
  let manager: RoomManager

  function makeResolvedModel() {
    return {
      provider: "test", modelId: "test-model",
      modelRegistry: {
        getAll: () => [],
        getProviderAuthStatus: () => "unauthenticated",
        getProviderDisplayName: () => "test",
        refresh: () => {},
        find: () => undefined,
      },
    } as any
  }

  beforeEach(() => {
    hub = new SseHub(1)
    manager = new RoomManager(makeResolvedModel(), hub, new Set(), [])
  })

  test("overridePersonas replaces seedPersonas entirely", () => {
    // Verify the contract at the Room level: seedPersonas should be the overrides.
    const seedPersona: Persona = makePersona("seed-agent")
    const mgr = new RoomManager(makeResolvedModel(), hub, new Set(), [seedPersona])

    const override: Persona = makePersona("override-agent")
    const room = mgr.createRoom("test", "Test", [override])

    // Access the private seedPersonas field via reflection.
    const seeds: Persona[] = (room as any).seedPersonas
    const ids = seeds.map(p => p.id)
    // Override replaces seeds — only "override-agent" should be present.
    expect(ids).toContain("override-agent")
    expect(ids).not.toContain("seed-agent")
  })

  test("createRoom without overridePersonas uses seedPersonas", () => {
    const seedPersona: Persona = makePersona("seed-agent")
    const mgr = new RoomManager(makeResolvedModel(), hub, new Set(), [seedPersona])

    const room = mgr.createRoom("test", "Test")

    // Without override, seedPersonas should be the manager's seeds.
    const seeds: Persona[] = (room as any).seedPersonas
    const ids = seeds.map(p => p.id)
    expect(ids).toContain("seed-agent")
  })

  test("listRooms includes goalStatus and goalText", () => {
    const room = manager.createRoom("goal-room", "Goal Room")
    ;(room as any).goalText = "do something"
    ;(room as any).goalStatus = "running"

    const list = manager.listRooms()
    const entry = list.find(r => r.roomId === "goal-room")!
    expect(entry.goalStatus).toBe("running")
    expect(entry.goalText).toBe("do something")
  })

  test("listRooms shows idle/null for non-goal rooms", () => {
    manager.createRoom("interactive-room", "Interactive")

    const [entry] = manager.listRooms()
    expect(entry.goalStatus).toBe("idle")
    expect(entry.goalText).toBeNull()
  })

  test("getRoomDetails returns undefined for unknown room", () => {
    expect(manager.getRoomDetails("ghost")).toBeUndefined()
  })

  test("getRoomDetails returns full details including goal fields", () => {
    const room = manager.createRoom("my-room", "My Room")
    ;(room as any).goalText = "build it"
    ;(room as any).goalStatus = "completed"

    const details = manager.getRoomDetails("my-room")!
    expect(details.roomId).toBe("my-room")
    expect(details.name).toBe("My Room")
    expect(details.goalText).toBe("build it")
    expect(details.goalStatus).toBe("completed")
    expect(typeof details.participantCount).toBe("number")
    expect(typeof details.isBusy).toBe("boolean")
    expect(typeof details.transcriptLength).toBe("number")
  })
})
