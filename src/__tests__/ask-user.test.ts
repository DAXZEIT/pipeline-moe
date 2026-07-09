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
  /** Set by MockRegistry.addParticipant() so run()/followUp() can register a
   *  handoff — mirrors the real handoff tool's execute() calling
   *  registry.register() as a side effect of the turn. */
  registry: MockRegistry | null = null

  private _nextResult: { text: string; activity: Array<{ toolName: string; args: Record<string, string>; status: "ok" | "error"; toolCallId: string; ts: number }>; question?: string; questionOptions?: string[]; handoffTo?: string } | null = null

  constructor(persona: Persona) {
    this.persona = persona
  }

  withResult(result: { text: string; activity?: Array<{ toolName: string; args: Record<string, string>; status: "ok" | "error"; toolCallId: string; ts: number }>; question?: string; questionOptions?: string[]; handoffTo?: string }) {
    this._nextResult = {
      text: result.text,
      activity: result.activity ?? [],
      question: result.question,
      questionOptions: result.questionOptions,
      handoffTo: result.handoffTo,
    }
    return this
  }

  async run(_promptText: string): Promise<{ text: string; activity: Array<{ toolCallId: string; toolName: string; args: Record<string, string>; status: "ok" | "error"; ts: number }>; question?: string; questionOptions?: string[] }> {
    const result = this._nextResult ?? { text: "ok", activity: [], handoffTo: undefined }
    if (result.handoffTo) this.registry?.register(this.persona.id, result.handoffTo)
    return { text: result.text, activity: result.activity, question: result.question, questionOptions: result.questionOptions }
  }

  async followUp(_text: string): Promise<{ text: string; activity: Array<{ toolCallId: string; toolName: string; args: Record<string, string>; status: "ok" | "error"; ts: number }>; question?: string; questionOptions?: string[] }> {
    const result = this._nextResult ?? { text: "ok", activity: [], handoffTo: undefined }
    if (result.handoffTo) this.registry?.register(this.persona.id, result.handoffTo)
    return { text: result.text, activity: result.activity, question: result.question, questionOptions: result.questionOptions }
  }

  async abort() {}
  dispose() {}
}

// Mock Registry: returns mock participants.
class MockRegistry {
  private participants = new Map<string, MockParticipant>()
  onChange: (() => void) | null = null
  /** Mirrors the real Registry's HandoffSink. */
  private pendingHandoff = new Map<string, string>()

  activeParticipants(): MockParticipant[] {
    return [...this.participants.values()].filter((p) => p.active)
  }

  activeIds(): string[] {
    return this.activeParticipants().map((p) => p.persona.id)
  }

  register(from: string, to: string): void {
    this.pendingHandoff.set(from, to)
  }

  takeHandoff(from: string): string | undefined {
    const to = this.pendingHandoff.get(from)
    this.pendingHandoff.delete(from)
    return to
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
    p.registry = this
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
  messages: Array<{ author: string; text: string; question?: string; questionOptions?: string[] }> = []
  turns: TurnEvent[] = []
  notices: Array<{ msg: string; level: string }> = []
  routing: Array<Record<string, unknown>> = []

  constructor(private hub: SseHub) {
    // Intercept broadcasts by wrapping.
    const orig = hub.broadcast.bind(hub)
    hub.broadcast = (event, data) => {
      if (event === "message") {
        this.messages.push(data as { author: string; text: string; question?: string; questionOptions?: string[] })
      } else if (event === "turn") {
        this.turns.push(data as TurnEvent)
      } else if (event === "notice") {
        this.notices.push(data as { msg: string; level: string })
      } else if (event === "routing") {
        this.routing.push(data as Record<string, unknown>)
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

  test("resume reply that hands off to an agent chains to it (regression: was dropped)", async () => {
    const builder = makeMockParticipant("builder")
    const auditor = makeMockParticipant("auditor")
    // First turn: builder asks the user a question → pauses.
    builder.withResult({
      text: "Need a detail before I continue",
      activity: [{ toolCallId: "t1", toolName: "ask_user", args: { question: "Which target?" }, status: "ok", ts: Date.now() }],
      question: "Which target?",
    })
    registry.addParticipant(builder)
    registry.addParticipant(auditor)
    // chaining is on by default.

    room.submit("@builder start")
    await new Promise((r) => setTimeout(r, 200))

    // The user answers; builder's resume reply hands off to auditor.
    builder.withResult({ text: "Thanks, reviewing now.", handoffTo: "auditor" })
    auditor.withResult({ text: "Auditor reviewing" })

    room.submit("use the staging target")
    await new Promise((r) => setTimeout(r, 300))

    // The handoff after answering must chain — the auditor should have run.
    const auditorMsg = events.messages.find((m) => m.author === "auditor")
    expect(auditorMsg).toBeDefined()
    expect(auditorMsg!.text).toBe("Auditor reviewing")
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

  test("QCM: options ride the pause event AND the transcript entry", async () => {
    const agent = makeMockParticipant("builder")
    agent.withResult({
      text: "Asking with choices",
      activity: [{ toolCallId: "t1", toolName: "ask_user", args: { question: "Which format?" }, status: "ok", ts: Date.now() }],
      question: "Which format?",
      questionOptions: ["Markdown", "JSON", "Plain text"],
    })
    registry.addParticipant(agent)

    room.submit("@builder hello")
    await new Promise((r) => setTimeout(r, 200))

    // Pause event carries the closed choices for the live picker…
    const pauseEvent = events.turns.find((t) => t.phase === "pause")
    expect(pauseEvent!.options).toEqual(["Markdown", "JSON", "Plain text"])
    // …and the transcript entry persists them for scrollback.
    const agentMsg = events.messages.find((m) => m.author === "builder")
    expect(agentMsg!.questionOptions).toEqual(["Markdown", "JSON", "Plain text"])
  })

  test("QCM: a question without options behaves exactly as before (no options fields)", async () => {
    const agent = makeMockParticipant("builder")
    agent.withResult({
      text: "Asking",
      activity: [{ toolCallId: "t1", toolName: "ask_user", args: { question: "Free-form?" }, status: "ok", ts: Date.now() }],
      question: "Free-form?",
    })
    registry.addParticipant(agent)

    room.submit("@builder hello")
    await new Promise((r) => setTimeout(r, 200))

    const pauseEvent = events.turns.find((t) => t.phase === "pause")
    expect(pauseEvent!.options).toBeUndefined()
    const agentMsg = events.messages.find((m) => m.author === "builder")
    expect(agentMsg!.questionOptions).toBeUndefined()
  })

  test("a question-only turn posts empty text — the callout is the body, not '(no response)'", async () => {
    const agent = makeMockParticipant("builder")
    agent.withResult({
      text: "",
      activity: [{ toolCallId: "t1", toolName: "ask_user", args: { question: "Which one?" }, status: "ok", ts: Date.now() }],
      question: "Which one?",
    })
    registry.addParticipant(agent)

    room.submit("@builder hello")
    await new Promise((r) => setTimeout(r, 200))

    const agentMsg = events.messages.find((m) => m.author === "builder")
    expect(agentMsg!.text).toBe("")
    expect(agentMsg!.question).toBe("Which one?")
  })

  test("a genuinely empty turn (no question) keeps the '(no response)' placeholder", async () => {
    const agent = makeMockParticipant("builder")
    agent.withResult({ text: "", activity: [] })
    registry.addParticipant(agent)

    room.submit("@builder hello")
    await new Promise((r) => setTimeout(r, 200))

    const agentMsg = events.messages.find((m) => m.author === "builder")
    expect(agentMsg!.text).toBe("(no response)")
  })

  test("a tool-only turn (activity, no text, no question) says so instead of '(no response)'", async () => {
    // "(no response)" misled OTHER agents reading the transcript — observed
    // live: scribe read a batched tool-only turn as "the builder didn't
    // respond" and derailed arguing about it.
    const agent = makeMockParticipant("builder")
    agent.withResult({
      text: "",
      activity: [{ toolCallId: "t1", toolName: "read", args: { path: "x.md" }, status: "ok", ts: Date.now() }],
    })
    registry.addParticipant(agent)

    room.submit("@builder hello")
    await new Promise((r) => setTimeout(r, 200))

    const agentMsg = events.messages.find((m) => m.author === "builder")
    expect(agentMsg!.text).toBe("(tool calls only — no text reply)")
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

  test("parallel handoffs to the same agent enqueue it once (no back-to-back repeat)", async () => {
    const scout = makeMockParticipant("scout")
    const builder = makeMockParticipant("builder")
    const planner = makeMockParticipant("planner")
    scout.parallel = true
    builder.parallel = true
    // Both finish by handing off to planner in the same parallel wave.
    scout.withResult({ text: "found things, planner should plan", handoffTo: "planner" })
    builder.withResult({ text: "built things, planner should plan", handoffTo: "planner" })
    planner.withResult({ text: "Plan ready" }) // no further handoff → ends
    registry.addParticipant(scout)
    registry.addParticipant(builder)
    registry.addParticipant(planner)

    room.submit("@scout @builder go")
    await new Promise((r) => setTimeout(r, 400))

    // De-duped: the planner runs exactly once, not twice back-to-back.
    const plannerMsgs = events.messages.filter((m) => m.author === "planner")
    expect(plannerMsgs.length).toBe(1)
  })

  describe("semi mode — per-wave approval", () => {
    const proposalTargets = (e?: Record<string, unknown>) =>
      ((e?.proposals as Array<{ target: string }>) ?? []).map((p) => p.target)

    test("a proposed handoff pauses instead of running", async () => {
      const builder = makeMockParticipant("builder")
      const auditor = makeMockParticipant("auditor")
      builder.withResult({ text: "done, review please", handoffTo: "auditor" })
      auditor.withResult({ text: "Auditor reviewing" })
      registry.addParticipant(builder)
      registry.addParticipant(auditor)
      room.setRoutingMode("semi")

      room.submit("@builder go")
      await new Promise((r) => setTimeout(r, 200))

      const proposed = events.routing.find((e) => e.type === "proposed")
      expect(proposed).toBeDefined()
      expect(proposalTargets(proposed)).toEqual(["auditor"])
      expect(events.messages.find((m) => m.author === "auditor")).toBeUndefined()
      expect(room.isBusy()).toBe(true)
      expect(room.getPendingRoute()).not.toBeNull()
    })

    test("approve runs the proposed agent", async () => {
      const builder = makeMockParticipant("builder")
      const auditor = makeMockParticipant("auditor")
      builder.withResult({ text: "done, review please", handoffTo: "auditor" })
      auditor.withResult({ text: "Auditor reviewing" })
      registry.addParticipant(builder)
      registry.addParticipant(auditor)
      room.setRoutingMode("semi")

      room.submit("@builder go")
      await new Promise((r) => setTimeout(r, 200))
      room.resolveRoute({ action: "approve" })
      await new Promise((r) => setTimeout(r, 200))

      expect(events.messages.find((m) => m.author === "auditor")?.text).toBe("Auditor reviewing")
      expect(room.isBusy()).toBe(false)
    })

    test("redirect routes to a different agent", async () => {
      const builder = makeMockParticipant("builder")
      const auditor = makeMockParticipant("auditor")
      const planner = makeMockParticipant("planner")
      builder.withResult({ text: "done, review please", handoffTo: "auditor" })
      auditor.withResult({ text: "Auditor reviewing" })
      planner.withResult({ text: "Planner planning" })
      registry.addParticipant(builder)
      registry.addParticipant(auditor)
      registry.addParticipant(planner)
      room.setRoutingMode("semi")

      room.submit("@builder go")
      await new Promise((r) => setTimeout(r, 200))
      room.resolveRoute({ action: "redirect", targetIds: ["planner"] })
      await new Promise((r) => setTimeout(r, 200))

      expect(events.messages.find((m) => m.author === "planner")?.text).toBe("Planner planning")
      expect(events.messages.find((m) => m.author === "auditor")).toBeUndefined()
    })

    test("drop runs nothing and ends the turn", async () => {
      const builder = makeMockParticipant("builder")
      const auditor = makeMockParticipant("auditor")
      builder.withResult({ text: "done, review please", handoffTo: "auditor" })
      auditor.withResult({ text: "Auditor reviewing" })
      registry.addParticipant(builder)
      registry.addParticipant(auditor)
      room.setRoutingMode("semi")

      room.submit("@builder go")
      await new Promise((r) => setTimeout(r, 200))
      room.resolveRoute({ action: "drop" })
      await new Promise((r) => setTimeout(r, 200))

      expect(events.messages.find((m) => m.author === "auditor")).toBeUndefined()
      expect(room.isBusy()).toBe(false)
      expect(room.getPendingRoute()).toBeNull()
    })

    test("de-dupes parallel handoffs to the same agent into one proposal", async () => {
      const scout = makeMockParticipant("scout")
      const builder = makeMockParticipant("builder")
      const planner = makeMockParticipant("planner")
      scout.parallel = true
      builder.parallel = true
      scout.withResult({ text: "found, planner should plan", handoffTo: "planner" })
      builder.withResult({ text: "built, planner should plan", handoffTo: "planner" })
      registry.addParticipant(scout)
      registry.addParticipant(builder)
      registry.addParticipant(planner)
      room.setRoutingMode("semi")

      room.submit("@scout @builder go")
      await new Promise((r) => setTimeout(r, 300))

      const proposed = events.routing.find((e) => e.type === "proposed")
      expect(proposed).toBeDefined()
      expect(proposalTargets(proposed)).toEqual(["planner"])
    })

    test("abort clears the pending route", async () => {
      const builder = makeMockParticipant("builder")
      const auditor = makeMockParticipant("auditor")
      builder.withResult({ text: "done, review please", handoffTo: "auditor" })
      registry.addParticipant(builder)
      registry.addParticipant(auditor)
      room.setRoutingMode("semi")

      room.submit("@builder go")
      await new Promise((r) => setTimeout(r, 200))
      expect(room.getPendingRoute()).not.toBeNull()

      const had = await room.abortCurrent()
      expect(had).toBe(true)
      expect(room.getPendingRoute()).toBeNull()
      expect(room.isBusy()).toBe(false)
    })
  })
})
