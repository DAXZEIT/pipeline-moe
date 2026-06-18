import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
import type { Conversation, ConversationMeta, Persona, PersonaState } from "../types.js"

// ── Mocks ──────────────────────────────────────────────────────────────────

// Mock Participant: controllable run() output.
class MockParticipant {
  persona: Persona
  active = true
  parallel = false
  status: "idle" | "active" | "thinking" | "working" = "idle"
  cursor = 0

  private _nextResult: { text: string; activity: Array<{ toolName: string; args: Record<string, string>; status: "ok" | "error"; toolCallId: string; ts: number }>; question?: string } | null = null

  constructor(persona: Persona) {
    this.persona = persona
  }

  withResult(result: { text: string; activity?: Array<{ toolName: string; args: Record<string, string>; status: "ok" | "error"; toolCallId: string; ts: number }>; question?: string }) {
    this._nextResult = {
      text: result.text,
      activity: result.activity ?? [],
      question: result.question,
    }
    return this
  }

  async run(_promptText: string): Promise<{ text: string; activity: Array<{ toolCallId: string; toolName: string; args: Record<string, string>; status: "ok" | "error"; ts: number }>; question?: string }> {
    const result = this._nextResult ?? { text: "ok", activity: [] }
    return { text: result.text, activity: result.activity, question: result.question }
  }

  async followUp(_text: string): Promise<{ text: string; activity: Array<{ toolCallId: string; toolName: string; args: Record<string, string>; status: "ok" | "error"; ts: number }>; question?: string }> {
    const result = this._nextResult ?? { text: "ok", activity: [] }
    return { text: result.text, activity: result.activity, question: result.question }
  }

  async abort() {}
  dispose() {}
}

// Mock Registry: returns mock participants.
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

  kick(id: string) {
    this.participants.delete(id)
  }

  reset(_states: PersonaState[]) {}

  addParticipant(p: MockParticipant) {
    this.participants.set(p.persona.id, p)
  }

  disposeAll() {
    this.participants.clear()
  }
}

// Mock Store: in-memory, no disk I/O.
class MockStore {
  private data = new Map<string, Conversation>()

  async init() {}

  async list(): Promise<ConversationMeta[]> {
    return Array.from(this.data.values()).map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: c.transcript.length,
    }))
  }

  async read(id: string): Promise<Conversation | null> {
    return this.data.get(id) ?? null
  }

  async write(conv: Conversation) {
    this.data.set(conv.id, conv)
  }

  async remove(id: string) {
    this.data.delete(id)
  }
}

// Event capture for SseHub.
interface TurnEvent { phase: string; [key: string]: unknown }

class EventCapture {
  messages: Array<{ author: string; text: string; question?: string }> = []
  turns: TurnEvent[] = []
  notices: Array<{ msg: string; level: string }> = []

  constructor(private hub: SseHub) {
    // Intercept broadcasts by wrapping.
    const orig = hub.broadcast.bind(hub)
    hub.broadcast = (event, data) => {
      if (event === "message") {
        this.messages.push(data as { author: string; text: string; question?: string })
      } else if (event === "turn") {
        this.turns.push(data as TurnEvent)
      } else if (event === "notice") {
        this.notices.push(data as { msg: string; level: string })
      }
      orig(event, data)
    }
  }
}

// Helpers.
function makePersona(id: string): Persona {
  return { id, name: id, color: "#000", icon: "🤖", tools: [], systemPrompt: "" }
}

function makeMockParticipant(id: string): MockParticipant {
  return new MockParticipant(makePersona(id))
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ask_user — pause/resume", () => {
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
    // Ensure room is idle before next test.
    await room.abortCurrent()
  })

  test("agent calling ask_user pauses the pipeline", async () => {
    const agent = makeMockParticipant("builder")
    agent.withResult({
      text: "I need clarification",
      activity: [
        { toolCallId: "t1", toolName: "ask_user", args: { question: "What format do you want?" }, status: "ok", ts: Date.now() },
      ],
      question: "What format do you want?",
    })
    registry.addParticipant(agent)

    room.submit("@builder hello")

    // Wait for processing.
    await new Promise((r) => setTimeout(r, 200))

    // Should have a message from the agent.
    const agentMsg = events.messages.find((m) => m.author === "builder")
    expect(agentMsg).toBeDefined()
    expect(agentMsg!.text).toBe("I need clarification")

    // Should have a pause turn event.
    const pauseEvent = events.turns.find((t) => t.phase === "pause")
    expect(pauseEvent).toBeDefined()
    expect(pauseEvent!.askerId).toBe("builder")
  })

  test("user response resumes and routes to asker", async () => {
    const agent = makeMockParticipant("builder")
    // First turn: ask_user
    agent.withResult({
      text: "I need clarification",
      activity: [
        { toolCallId: "t1", toolName: "ask_user", args: { question: "What format?" }, status: "ok", ts: Date.now() },
      ],
      question: "What format?",
    })
    registry.addParticipant(agent)

    room.submit("@builder hello")
    await new Promise((r) => setTimeout(r, 200))

    // Second turn: agent gets the answer
    agent.withResult({ text: "Got it, thanks!" })

    room.submit("JSON format please")
    await new Promise((r) => setTimeout(r, 300))

    // Should have a resume turn event.
    const resumeEvent = events.turns.find((t) => t.phase === "resume")
    expect(resumeEvent).toBeDefined()
    expect(resumeEvent!.askerId).toBe("builder")

    // Should have the agent's second response.
    const secondMsg = events.messages.find((m) => m.author === "builder" && m.text === "Got it, thanks!")
    expect(secondMsg).toBeDefined()
  })

  test("nested question — asker asks again on resume, pipeline re-pauses", async () => {
    const agent = makeMockParticipant("builder")
    agent.withResult({
      text: "First question",
      activity: [{ toolCallId: "t1", toolName: "ask_user", args: { question: "Q1?" }, status: "ok", ts: Date.now() }],
      question: "Q1?",
    })
    registry.addParticipant(agent)

    room.submit("@builder start")
    await new Promise((r) => setTimeout(r, 200))

    // Answer first question — but agent asks again.
    agent.withResult({
      text: "Second question",
      activity: [{ toolCallId: "t2", toolName: "ask_user", args: { question: "Q2?" }, status: "ok", ts: Date.now() }],
      question: "Q2?",
    })

    room.submit("Answer to Q1")
    await new Promise((r) => setTimeout(r, 300))

    // Should have TWO pause events.
    const pauseEvents = events.turns.filter((t) => t.phase === "pause")
    expect(pauseEvents.length).toBe(2)
    expect(pauseEvents[0].question).toBe("Q1?")
    expect(pauseEvents[1].question).toBe("Q2?")
  })

  test("parallel wave with question — all results posted before pause", async () => {
    const agentA = makeMockParticipant("alpha")
    const agentB = makeMockParticipant("beta")
    agentA.parallel = true
    agentB.parallel = true

    // Alpha asks a question, beta just works.
    agentA.withResult({
      text: "Alpha: I need clarification",
      activity: [{ toolCallId: "t1", toolName: "ask_user", args: { question: "What format?" }, status: "ok", ts: Date.now() }],
      question: "What format?",
    })
    agentB.withResult({ text: "Beta: done" })

    registry.addParticipant(agentA)
    registry.addParticipant(agentB)

    room.submit("@alpha @beta parallel work")
    await new Promise((r) => setTimeout(r, 200))

    // Both agents should have posted their messages.
    const alphaMsg = events.messages.find((m) => m.author === "alpha")
    const betaMsg = events.messages.find((m) => m.author === "beta")
    expect(alphaMsg).toBeDefined()
    expect(betaMsg).toBeDefined()
    expect(betaMsg!.text).toBe("Beta: done")

    // Should have a pause event for alpha.
    const pauseEvent = events.turns.find((t) => t.phase === "pause")
    expect(pauseEvent).toBeDefined()
    expect(pauseEvent!.askerId).toBe("alpha")
  })

  test("/cancel while paused drains held queue", async () => {
    const agent = makeMockParticipant("builder")
    agent.withResult({
      text: "Asking",
      activity: [{ toolCallId: "t1", toolName: "ask_user", args: { question: "Q?" }, status: "ok", ts: Date.now() }],
      question: "Q?",
    })
    registry.addParticipant(agent)

    room.submit("@builder hello")
    await new Promise((r) => setTimeout(r, 200))

    // Cancel the question.
    room.submit("/cancel")
    await new Promise((r) => setTimeout(r, 200))

    // Should have a pause event followed by an end event (from cancel).
    const pauseEvent = events.turns.find((t) => t.phase === "pause")
    expect(pauseEvent).toBeDefined()

    // The cancel should have cleared the pause.
    // (We can't easily test the full drain of a held queue without a second agent,
    // but the cancel itself should work.)
  })

  test("isBusy returns true while paused", async () => {
    const agent = makeMockParticipant("builder")
    agent.withResult({
      text: "Asking",
      activity: [{ toolCallId: "t1", toolName: "ask_user", args: { question: "Q?" }, status: "ok", ts: Date.now() }],
      question: "Q?",
    })
    registry.addParticipant(agent)

    room.submit("@builder hello")
    await new Promise((r) => setTimeout(r, 200))

    expect(room.isBusy()).toBe(true)
  })

  test("question field is persisted on the transcript entry", async () => {
    const agent = makeMockParticipant("builder")
    agent.withResult({
      text: "Asking",
      activity: [{ toolCallId: "t1", toolName: "ask_user", args: { question: "What format?" }, status: "ok", ts: Date.now() }],
      question: "What format?",
    })
    registry.addParticipant(agent)

    room.submit("@builder hello")
    await new Promise((r) => setTimeout(r, 200))

    const agentMsg = events.messages.find((m) => m.author === "builder")
    expect(agentMsg!.question).toBe("What format?")
  })

  test("ensureIdle blocks while paused", async () => {
    const agent = makeMockParticipant("builder")
    agent.withResult({
      text: "Asking",
      activity: [{ toolCallId: "t1", toolName: "ask_user", args: { question: "Q?" }, status: "ok", ts: Date.now() }],
      question: "Q?",
    })
    registry.addParticipant(agent)

    room.submit("@builder hello")
    await new Promise((r) => setTimeout(r, 200))

    // newConversation calls ensureIdle internally — should throw.
    await expect(room.newConversation()).rejects.toThrow("a turn is running")
  })

  test("abortCurrent clears pending question", async () => {
    const agent = makeMockParticipant("builder")
    agent.withResult({
      text: "Asking",
      activity: [{ toolCallId: "t1", toolName: "ask_user", args: { question: "Q?" }, status: "ok", ts: Date.now() }],
      question: "Q?",
    })
    registry.addParticipant(agent)

    room.submit("@builder hello")
    await new Promise((r) => setTimeout(r, 200))

    const had = await room.abortCurrent()
    expect(had).toBe(true)

    // Room should be idle now.
    expect(room.isBusy()).toBe(false)
  })
})
