import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
import type { Persona, PersonaState } from "../types.js"

// A local model with no mmproj loaded refuses the request outright if an
// image reaches it — Room.buildContext must never attach images to a
// participant whose persona has vision:false, regardless of whether it was
// the message's mentioned target or just happens to be in the run group.

class MockParticipant {
  persona: Persona
  active = true
  parallel = false
  status: "idle" | "active" | "thinking" | "working" = "idle"
  cursor = 0
  lastImages: string[] | undefined
  lastText = ""

  constructor(persona: Persona) {
    this.persona = persona
  }

  async run(text: string, images?: string[]) {
    this.lastText = text
    this.lastImages = images
    return { text: "(done)", activity: [], reasoning: undefined, question: undefined }
  }

  async followUp(text: string, images?: string[]) {
    return this.run(text, images)
  }

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
    return [...this.parts.values()].map((p) => ({
      id: p.persona.id, name: p.persona.name, color: p.persona.color,
      icon: p.persona.icon, tools: p.persona.tools, active: p.active,
      status: p.status, parallel: p.parallel, vision: p.persona.vision,
    }))
  }
  activeParticipants() { return [...this.parts.values()].filter((p) => p.active) }
  personaStates(): PersonaState[] {
    return [...this.parts.values()].map((p) => ({ ...p.persona, active: p.active, parallel: p.parallel }))
  }
  broadcastRoster() {}
  reset(_states: any[]) {}
  setActive(id: string, active: boolean) { const p = this.parts.get(id); if (p) p.active = active }
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

function makePersona(id: string, vision?: boolean): Persona {
  return { id, name: id, color: "#000", icon: "🤖", tools: [], systemPrompt: "", vision }
}

describe("Vision gating — images never reach an agent without vision", () => {
  let registry: MockRegistry
  let hub: SseHub
  let store: MockStore
  let room: Room

  beforeEach(() => {
    hub = new SseHub(1)
    store = new MockStore()
    registry = new MockRegistry()
  })

  afterEach(async () => {
    await room.abortCurrent()
  })

  test("vision:false agent gets no images, plus a note explaining why", async () => {
    const blind = new MockParticipant(makePersona("blind", false))
    registry.add(blind)
    room = new Room(registry as any, hub, store as any, [], "test-room")
    await room.init()

    room.submit("@blind look at this", ["media/pic.png"])
    await new Promise<void>((resolve) => setTimeout(resolve, 300))

    expect(blind.lastImages).toBeUndefined()
    expect(blind.lastText).toContain("you don't have vision enabled")
  })

  test("vision left undefined (default) still receives images", async () => {
    const sighted = new MockParticipant(makePersona("sighted"))
    registry.add(sighted)
    room = new Room(registry as any, hub, store as any, [], "test-room")
    await room.init()

    room.submit("@sighted look at this", ["media/pic.png"])
    await new Promise<void>((resolve) => setTimeout(resolve, 300))

    expect(sighted.lastImages).toEqual(["media/pic.png"])
  })

  test("mixed @all turn: sighted agent sees the image, blind agent does not", async () => {
    const sighted = new MockParticipant(makePersona("sighted"))
    const blind = new MockParticipant(makePersona("blind", false))
    registry.add(sighted)
    registry.add(blind)
    room = new Room(registry as any, hub, store as any, [], "test-room")
    await room.init()

    room.submit("@all look at this", ["media/pic.png"])
    await new Promise<void>((resolve) => setTimeout(resolve, 400))

    expect(sighted.lastImages).toEqual(["media/pic.png"])
    expect(blind.lastImages).toBeUndefined()
  })
})
