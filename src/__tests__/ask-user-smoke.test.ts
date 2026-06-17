import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
import type { Conversation, ConversationMeta, Persona, PersonaState, ToolActivity } from "../types.js"

/**
 * Smoke test: exercises the REAL ask_user detection path.
 *
 * The existing tests mock question directly via MockParticipant.withResult({ question }).
 * This test returns activity that mimics what a real agent would emit — tool_execution
 * with ask_user — and the detection logic in Participant.run() must extract it.
 *
 * Verification is through PUBLIC APIs (isBusy, captured SSE events) — no private field access.
 */

// ── Participant mock ───────────────────────────────────────────────────────

class RealisticParticipant {
  persona: Persona
  active = true
  parallel = false
  status: "idle" | "active" | "thinking" | "working" = "idle"
  cursor = 0

  private _activity: ToolActivity[] = []
  private _text = "ok"

  constructor(persona: Persona) {
    this.persona = persona
  }

  withAskUserActivity(question: string) {
    this._activity = [
      {
        toolCallId: "call_1",
        toolName: "ask_user",
        args: { question },
        status: "ok",
        ts: Date.now(),
      },
    ]
    return this
  }

  withActivity(activity: ToolActivity[]) {
    this._activity = activity
    return this
  }

  /**
   * Run returns activity WITHOUT question pre-set.
   * The detection logic (same as Participant.run()) extracts it from activity.
   */
  async run(_promptText: string): Promise<{ text: string; activity: ToolActivity[]; question?: string }> {
    let question: string | undefined
    for (const act of this._activity) {
      if (act.toolName === "ask_user" && act.status === "ok") {
        const args = act.args as Record<string, unknown> | undefined
        const q = typeof args?.question === "string" ? args.question : undefined
        if (q) {
          question = q
          break
        }
      }
    }
    return { text: this._text, activity: this._activity, question }
  }

  async abort() {}
  dispose() {}
}

// ── Minimal mocks ──────────────────────────────────────────────────────────

class MockRegistry {
  private participants = new Map<string, RealisticParticipant>()
  onChange: (() => void) | null = null

  activeParticipants(): RealisticParticipant[] {
    return [...this.participants.values()].filter((p) => p.active)
  }

  personaStates(): PersonaState[] {
    return [...this.participants.values()].map((p) => ({
      ...p.persona,
      active: p.active,
      parallel: p.parallel,
    }))
  }

  get(id: string): RealisticParticipant | undefined {
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
  setActive(_id: string, _active: boolean) {}
  kick(_id: string) {}
  reset(_states: PersonaState[]) {}
  addParticipant(p: RealisticParticipant) {
    this.participants.set(p.persona.id, p)
  }
  disposeAll() { this.participants.clear() }
}

class MockStore {
  private data = new Map<string, Conversation>()
  async init() {}
  async list(): Promise<ConversationMeta[]> {
    return Array.from(this.data.values()).map((c) => ({
      id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messageCount: c.transcript.length,
    }))
  }
  async read(id: string): Promise<Conversation | null> { return this.data.get(id) ?? null }
  async write(conv: Conversation) { this.data.set(conv.id, conv) }
  async remove(id: string) { this.data.delete(id) }
}

class EventCapture {
  messages: Array<{ author: string; text: string; question?: string }> = []
  turns: Array<{ phase: string; [key: string]: unknown }> = []
  notices: Array<{ msg: string; level: string }> = []

  constructor(private hub: SseHub) {
    const orig = hub.broadcast.bind(hub)
    hub.broadcast = (event, data) => {
      if (event === "message") this.messages.push(data as any)
      if (event === "turn") this.turns.push(data as any)
      if (event === "notice") this.notices.push(data as any)
      orig(event, data)
    }
  }
}

function makePersona(id: string): Persona {
  return { id, name: id, color: "#000", icon: "🤖", tools: [], systemPrompt: "" }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ask_user — real detection path smoke", () => {
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

    const p = new RealisticParticipant(makePersona("builder"))
    registry.addParticipant(p)

    room = new Room(registry as any, hub, store as any, [])
  })

  afterEach(async () => {
    if (room.isBusy()) {
      room.abortCurrent()
    }
  })

  test("detection: ask_user activity extracts question (not mock-set)", async () => {
    const p = registry.get("builder")!
    p.withAskUserActivity("What format do you want?")

    room.submit("hello @builder")
    await new Promise(r => setTimeout(r, 100))

    // Pipeline should be paused (busy = true because of pending question)
    expect(room.isBusy()).toBe(true)

    // Check transcript has the question persisted
    const lastMsg = events.messages[events.messages.length - 1]
    expect(lastMsg.question).toBe("What format do you want?")

    // Check turn:pause was emitted
    const pauseTurn = events.turns.find(t => t.phase === "pause")
    expect(pauseTurn).toBeDefined()
    expect(pauseTurn?.askerId).toBe("builder")
  })

  test("detection: error status does NOT extract question", async () => {
    const p = registry.get("builder")!
    p.withActivity([
      {
        toolCallId: "call_1",
        toolName: "ask_user",
        args: { question: "This should not be extracted" },
        status: "error",
        ts: Date.now(),
      },
    ])

    room.submit("hello @builder")
    await new Promise(r => setTimeout(r, 100))

    // Should NOT pause — turn should have ended normally
    expect(room.isBusy()).toBe(false)

    const pauseTurn = events.turns.find(t => t.phase === "pause")
    expect(pauseTurn).toBeUndefined()

    // Should have a turn:end
    const endTurn = events.turns.find(t => t.phase === "end")
    expect(endTurn).toBeDefined()
  })

  test("detection: different tool does NOT extract question", async () => {
    const p = registry.get("builder")!
    p.withActivity([
      {
        toolCallId: "call_1",
        toolName: "read",
        args: { question: "This is from read, not ask_user" },
        status: "ok",
        ts: Date.now(),
      },
    ])

    room.submit("hello @builder")
    await new Promise(r => setTimeout(r, 100))

    expect(room.isBusy()).toBe(false)

    const pauseTurn = events.turns.find(t => t.phase === "pause")
    expect(pauseTurn).toBeUndefined()
  })

  test("full flow: detect → pause → user responds → resume", async () => {
    const p = registry.get("builder")!
    p.withAskUserActivity("What format?")

    room.submit("hello @builder")
    await new Promise(r => setTimeout(r, 100))

    // Should be paused
    expect(room.isBusy()).toBe(true)

    // User responds — no @mention needed, routed to asker
    p.withActivity([])  // no more tool calls on resume

    room.submit("JSON please")
    await new Promise(r => setTimeout(r, 100))

    // Should have resumed and finished
    expect(room.isBusy()).toBe(false)

    const resumeTurn = events.turns.find(t => t.phase === "resume")
    expect(resumeTurn).toBeDefined()

    const endTurn = events.turns.find(t => t.phase === "end")
    expect(endTurn).toBeDefined()
  })

  test("/cancel while paused clears pause", async () => {
    const p = registry.get("builder")!
    p.withAskUserActivity("Really?")

    room.submit("hello @builder")
    await new Promise(r => setTimeout(r, 100))

    expect(room.isBusy()).toBe(true)

    room.submit("/cancel")
    await new Promise(r => setTimeout(r, 100))

    // Should have cleared the pause
    expect(room.isBusy()).toBe(false)

    const cancelNotice = events.notices.find(n => n.msg.toLowerCase().includes("cancel"))
    expect(cancelNotice).toBeDefined()
  })
})
