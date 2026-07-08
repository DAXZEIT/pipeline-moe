import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
import type { Conversation, ConversationMeta, Persona, PersonaState } from "../types.js"

// PLAN-ea321024 — turn-state tracking, tested against a REAL Room (retro
// lesson from PLAN-c1874a35: integration tests drive a real Room and observe
// the events it emits — they don't re-test pure functions).
//
// Bug 1: `turn start` carried only the turn's FIRST agent, so the client's
//        status bar showed "running Planner" for a whole planner→builder drain.
//        Fixed by a `turn {phase:"agent"}` event on every real agent start.
// Bug 2: compact was refused during an ask_user pause (isBusy counts
//        pendingQuestion) while the UI said "idle". Fixed by isGenerating().
// Bug 3: a fresh @mention in the post-resume reply ran AFTER work frozen in
//        the heldQueue, invisibly. Fixed: fresh mentions prepend + order notice.

type Activity = Array<{ toolCallId: string; toolName: string; args: Record<string, string>; status: "ok" | "error"; ts: number }>
type RunResult = { text: string; activity: Activity; question?: string }

class MockParticipant {
  persona: Persona
  active = true
  parallel = false
  status: "idle" | "active" | "thinking" | "working" = "idle"
  cursor = 0
  compactCalls = 0

  private results: RunResult[] = []
  private delayMs = 0

  constructor(persona: Persona, private execLog: string[]) {
    this.persona = persona
  }

  /** Queue replies in order — first run() consumes the first, etc. */
  queueResult(r: { text: string; question?: string }): this {
    this.results.push({
      text: r.text,
      activity: r.question
        ? [{ toolCallId: "t1", toolName: "ask_user", args: { question: r.question }, status: "ok", ts: Date.now() }]
        : [],
      question: r.question,
    })
    return this
  }

  withDelay(ms: number): this {
    this.delayMs = ms
    return this
  }

  private async exec(): Promise<RunResult> {
    this.execLog.push(this.persona.id)
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
    return this.results.shift() ?? { text: "ok", activity: [] }
  }

  async run(_text: string, _images?: string[]) {
    return this.exec()
  }

  async followUp(_text: string, _images?: string[]) {
    return this.exec()
  }

  async compact(): Promise<{ summary: string; tokensBefore: number }> {
    this.compactCalls++
    return { summary: "compacted", tokensBefore: 12345 }
  }

  // Fallback/plan routing and work-receipt injection call this on the routed
  // target — a mock without it kills the whole drain with a TypeError.
  async sendCustomMessage(_msg: unknown, _opts?: unknown) {}

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
    return [...this.participants.values()].map((p) => ({ ...p.persona, active: p.active, parallel: p.parallel }))
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

interface TurnEvent {
  phase: string
  [key: string]: unknown
}

class EventCapture {
  messages: Array<{ author: string; text: string; question?: string }> = []
  turns: TurnEvent[] = []
  notices: Array<{ msg: string; level: string }> = []

  constructor(hub: SseHub) {
    const orig = hub.broadcast.bind(hub)
    hub.broadcast = (event, data) => {
      if (event === "message") this.messages.push(data as { author: string; text: string; question?: string })
      else if (event === "turn") this.turns.push(data as TurnEvent)
      else if (event === "notice") this.notices.push(data as { msg: string; level: string })
      orig(event, data)
    }
  }
}

function makePersona(id: string): Persona {
  return { id, name: id, color: "#000", icon: "🤖", tools: [], systemPrompt: "" }
}

describe("Turn-state tracking (PLAN-ea321024)", () => {
  let registry: MockRegistry
  let hub: SseHub
  let store: MockStore
  let room: Room
  let events: EventCapture
  let execLog: string[]

  beforeEach(() => {
    hub = new SseHub(1)
    store = new MockStore()
    registry = new MockRegistry()
    events = new EventCapture(hub)
    execLog = []
    room = new Room(registry as any, hub, store as any, [])
    // No fallback routing in these tests — exact execution order is asserted,
    // and the default fallback ("planner") would re-enqueue extra runs.
    room.setFallbackAgent(null)
  })

  afterEach(async () => {
    await room.abortCurrent()
  })

  test("turn {phase:'agent'} tracks each agent of a chained drain, in order", async () => {
    const a = new MockParticipant(makePersona("planner"), execLog).queueResult({ text: "over to @builder" })
    const b = new MockParticipant(makePersona("builder"), execLog).queueResult({ text: "done" })
    registry.addParticipant(a)
    registry.addParticipant(b)

    room.submit("@planner go")
    await new Promise((r) => setTimeout(r, 300))

    // turn start still carries the first agent (unchanged contract)…
    const start = events.turns.find((t) => t.phase === "start")
    expect(start?.agentId).toBe("planner")
    // …and phase:"agent" now follows the real drain: planner, then builder.
    const agentPhases = events.turns.filter((t) => t.phase === "agent").map((t) => t.agentId)
    expect(agentPhases).toEqual(["planner", "builder"])
    expect(execLog).toEqual(["planner", "builder"])
  })

  test("ask_user pause: isBusy() true but isGenerating() false", async () => {
    const asker = new MockParticipant(makePersona("planner"), execLog).queueResult({
      text: "need input",
      question: "Which one?",
    })
    registry.addParticipant(asker)

    room.submit("@planner go")
    await new Promise((r) => setTimeout(r, 200))

    expect(room.isBusy()).toBe(true) // frozen queue + pending question
    expect(room.isGenerating()).toBe(false) // …but nothing is running
  })

  test("mid-generation: isGenerating() true", async () => {
    const slow = new MockParticipant(makePersona("builder"), execLog).withDelay(250)
    registry.addParticipant(slow)

    room.submit("@builder go")
    await new Promise((r) => setTimeout(r, 80))

    expect(room.isGenerating()).toBe(true)
    expect(room.isBusy()).toBe(true)
    await new Promise((r) => setTimeout(r, 400))
    expect(room.isGenerating()).toBe(false)
  })

  test("compacting the ASKER during its own pause, then resuming, stays coherent", async () => {
    const asker = new MockParticipant(makePersona("planner"), execLog)
    asker.queueResult({ text: "need input", question: "Which one?" })
    asker.queueResult({ text: "thanks, proceeding" })
    registry.addParticipant(asker)

    room.submit("@planner go")
    await new Promise((r) => setTimeout(r, 200))

    // Compact the agent that asked, while its question is pending (risk #1).
    room.submit("/compact @planner")
    await new Promise((r) => setTimeout(r, 200))
    expect(asker.compactCalls).toBe(1)
    expect(events.notices.some((n) => n.msg.includes("compacted"))).toBe(true)
    // The pause survived the compact.
    expect(room.isBusy()).toBe(true)

    // Answer → resume goes to the (compacted) asker via followUp.
    room.submit("option A")
    await new Promise((r) => setTimeout(r, 300))

    expect(events.turns.some((t) => t.phase === "resume" && t.askerId === "planner")).toBe(true)
    expect(events.messages.some((m) => m.author === "planner" && m.text === "thanks, proceeding")).toBe(true)
    expect(room.isBusy()).toBe(false)
  })

  test("post-resume fresh mention runs BEFORE the held queue, with an order notice", async () => {
    const asker = new MockParticipant(makePersona("planner"), execLog)
    asker.queueResult({ text: "hold on", question: "Approve?" })
    asker.queueResult({ text: "approved — @builder take over" })
    const held = new MockParticipant(makePersona("scribe"), execLog).queueResult({ text: "memory updated" })
    const fresh = new MockParticipant(makePersona("builder"), execLog).queueResult({ text: "building" })
    registry.addParticipant(asker)
    registry.addParticipant(held)
    registry.addParticipant(fresh)

    // Both targeted: planner runs first and pauses; scribe is frozen in heldQueue.
    room.submit("@planner @scribe go")
    await new Promise((r) => setTimeout(r, 200))
    expect(execLog).toEqual(["planner"])

    // Answer → planner's reply mentions @builder: recent intent runs first,
    // the held @scribe follows (dax's call, 2026-07-08).
    room.submit("yes, approved")
    await new Promise((r) => setTimeout(r, 400))

    expect(execLog).toEqual(["planner", "planner", "builder", "scribe"])
    const order = events.notices.find((n) => n.msg.startsWith("Resuming:"))
    expect(order).toBeDefined()
    expect(order!.msg).toBe("Resuming: @builder, then @scribe (held)")
  })
})
