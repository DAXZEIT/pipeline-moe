import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
import type { Conversation, ConversationMeta, Persona, PersonaState } from "../types.js"

// ── Mocks (same pattern as ask-user.test.ts) ───────────────────────────────

class MockParticipant {
  persona: Persona
  active = true
  parallel = false
  status: "idle" | "active" | "thinking" | "working" = "idle"
  cursor = 0
  isCompacting = false

  private _nextResult: { text: string; activity: any[]; question?: string } | null = null
  private _compactResult: { summary: string; tokensBefore: number } = {
    summary: "Compacted summary of previous conversation.",
    tokensBefore: 50000,
  }
  private _compactShouldFail = false
  private _compactError = "compaction failed"

  constructor(persona: Persona) {
    this.persona = persona
  }

  withResult(result: { text: string; activity?: any[]; question?: string }) {
    this._nextResult = { text: result.text, activity: result.activity ?? [], question: result.question }
    return this
  }

  withCompactResult(result: { summary: string; tokensBefore: number }) {
    this._compactResult = result
    return this
  }

  withCompactFailure(error: string) {
    this._compactShouldFail = true
    this._compactError = error
    return this
  }

  async run(_promptText: string) {
    const result = this._nextResult ?? { text: "ok", activity: [] }
    return { text: result.text, activity: result.activity, question: result.question }
  }

  async compact(): Promise<{ summary: string; tokensBefore: number }> {
    if (this._compactShouldFail) throw new Error(this._compactError)
    return this._compactResult
  }

  async abort() {}
  dispose() {}
}

class MockRegistry {
  private participants = new Map<string, MockParticipant>()
  onChange: (() => void) | null = null

  activeParticipants(): MockParticipant[] {
    return [...this.participants.values()].filter((p) => p.active)
  }

  personaStates(): PersonaState[] {
    return [...this.participants.values()].map((p) => ({
      ...p.persona,
      active: p.active,
      parallel: p.parallel,
    }))
  }

  get(id: string): MockParticipant | undefined {
    return this.participants.get(id)
  }

  has(id: string): boolean {
    return this.participants.has(id)
  }

  roster() {
    return [...this.participants.values()].map((p) => ({
      id: p.persona.id,
      name: p.persona.name,
      color: p.persona.color,
      icon: p.persona.icon,
      tools: p.persona.tools,
      active: p.active,
      status: p.status,
      parallel: p.parallel,
    }))
  }

  broadcastRoster() {}
  setActive(id: string, active: boolean) {
    const p = this.participants.get(id)
    if (p) p.active = active
  }
  kick(id: string) { this.participants.delete(id) }
  reset(_states: PersonaState[]) {}

  addParticipant(p: MockParticipant) {
    this.participants.set(p.persona.id, p)
  }

  disposeAll() { this.participants.clear() }
}

class MockStore {
  private data = new Map<string, Conversation>()
  async init() {}
  async list(): Promise<ConversationMeta[]> {
    return Array.from(this.data.values()).map((c) => ({
      id: c.id, title: c.title, createdAt: c.createdAt,
      updatedAt: c.updatedAt, messageCount: c.transcript.length,
    }))
  }
  async read(id: string): Promise<Conversation | null> { return this.data.get(id) ?? null }
  async write(conv: Conversation) { this.data.set(conv.id, conv) }
  async remove(id: string) { this.data.delete(id) }
}

interface NoticeEvent { msg: string; level: string }

class EventCapture {
  notices: NoticeEvent[] = []

  constructor(private hub: SseHub) {
    const orig = hub.broadcast.bind(hub)
    hub.broadcast = (event, data) => {
      if (event === "notice") {
        this.notices.push(data as NoticeEvent)
      }
      orig(event, data)
    }
  }
}

function makePersona(id: string): Persona {
  return { id, name: id, color: "#000", icon: "🤖", tools: [], systemPrompt: "" }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("/compact slash command", () => {
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

  test("/compact @agent compacts the agent's context", async () => {
    const agent = new MockParticipant(makePersona("builder"))
    agent.withCompactResult({ summary: "Previous discussion about types.", tokensBefore: 42000 })
    registry.addParticipant(agent)

    room.submit("/compact @builder")
    await new Promise((r) => setTimeout(r, 200))

    const successNotice = events.notices.find((n) => n.msg.includes("compacted"))
    expect(successNotice).toBeDefined()
    expect(successNotice!.msg).toContain("42000 tokens")
  })

  test("/compact without agent name shows usage error", async () => {
    room.submit("/compact")
    await new Promise((r) => setTimeout(r, 200))

    const errorNotice = events.notices.find((n) => n.msg.includes("usage"))
    expect(errorNotice).toBeDefined()
    expect(errorNotice!.level).toBe("error")
  })

  test("/compact with unknown agent shows error", async () => {
    room.submit("/compact @nonexistent")
    await new Promise((r) => setTimeout(r, 200))

    const errorNotice = events.notices.find((n) => n.msg.includes("unknown"))
    expect(errorNotice).toBeDefined()
    expect(errorNotice!.level).toBe("error")
  })

  test("/compact during an ask_user pause is allowed (guard is isGenerating, not isBusy)", async () => {
    const agent = new MockParticipant(makePersona("builder"))
    agent.withResult({
      text: "Asking",
      activity: [{ toolCallId: "t1", toolName: "ask_user", args: { question: "Q?" }, status: "ok", ts: Date.now() }],
      question: "Q?",
    })
    registry.addParticipant(agent)

    // Start a turn that will pause (ask_user)
    room.submit("@builder hello")
    await new Promise((r) => setTimeout(r, 200))

    // Paused: busy (frozen queue + pending question) but NOT generating —
    // exactly the window where compacting is safe and useful (PLAN-ea321024).
    expect(room.isBusy()).toBe(true)
    expect(room.isGenerating()).toBe(false)

    room.submit("/compact @builder")
    await new Promise((r) => setTimeout(r, 200))

    const successNotice = events.notices.find((n) => n.msg.includes("compacted"))
    expect(successNotice).toBeDefined()
    // The pause survives the compact — the question is still pending.
    expect(room.isBusy()).toBe(true)
  })

  test("/compact handles compaction failure gracefully", async () => {
    const agent = new MockParticipant(makePersona("builder"))
    agent.withCompactFailure("context too short to compact")
    registry.addParticipant(agent)

    room.submit("/compact @builder")
    await new Promise((r) => setTimeout(r, 200))

    const errorNotice = events.notices.find((n) => n.msg.includes("failed"))
    expect(errorNotice).toBeDefined()
    expect(errorNotice!.msg).toContain("context too short to compact")
  })
})
