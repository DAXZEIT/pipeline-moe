import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
import type { Persona, PersonaState } from "../types.js"

// ── Mocks ────────────────────────────────────────────────────────────────────

/** A participant whose run() emits a fixed sequence of replies (one per call,
 *  clamped to the last). Records injected custom messages for assertions. */
class SeqParticipant {
  persona: Persona
  active = true
  parallel = false
  status: "idle" | "active" | "thinking" | "working" = "idle"
  cursor = 0
  private replies: string[]
  callCount = 0
  customMessages: Array<{ customType: string; content: string }> = []

  constructor(persona: Persona, replies: string[]) {
    this.persona = persona
    this.replies = replies.length > 0 ? replies : ["(done)"]
  }

  async run(_text: string) {
    const text = this.replies[Math.min(this.callCount, this.replies.length - 1)]
    this.callCount++
    return { text, activity: [], reasoning: undefined, question: undefined }
  }

  async followUp(_text: string) { return this.run(_text) }

  async sendCustomMessage(
    message: { customType: string; content: string; display: boolean },
    _options?: unknown,
  ) {
    this.customMessages.push({ customType: message.customType, content: message.content })
  }

  getContextUsage() { return undefined }
  getSessionStats() { return undefined }
  getAvailableThinkingLevels() { return [] }
}

class MockRegistry {
  private parts = new Map<string, SeqParticipant>()
  onChange: (() => void) | null = null

  add(p: SeqParticipant) { this.parts.set(p.persona.id, p) }
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

function makePersona(id: string): Persona {
  return { id, name: id, color: "#000", icon: "🤖", tools: [], systemPrompt: "" }
}

const priv = (r: Room) => r as any
const settle = (ms = 300) => new Promise<void>(resolve => setTimeout(resolve, ms))

// ── Goal-eval loop tests ──────────────────────────────────────────────────────

describe("Room goal-eval loop", () => {
  let registry: MockRegistry
  let hub: SseHub
  let store: MockStore
  let room: Room
  let roomEvents: Array<{ type: string; iteration?: number; reason?: string }>

  beforeEach(() => {
    hub = new SseHub(1)
    store = new MockStore()
    registry = new MockRegistry()
    room = new Room(registry as any, hub, store as any, [], "eval-room")
    roomEvents = []
    const orig = hub.broadcast.bind(hub)
    hub.broadcast = (event, data, roomId?) => {
      if (event === "room") roomEvents.push(data as any)
      orig(event, data, roomId)
    }
  })

  afterEach(async () => {
    await room.abortCurrent()
  })

  test("auto mode (default) still completes on natural drain", async () => {
    registry.add(new SeqParticipant(makePersona("worker"), ["(all done)"]))
    await room.init()

    room.submitGoal("@worker do it") // no opts → auto mode
    await settle()

    expect(room.getGoalMode()).toBe("auto")
    expect(room.getGoalStatus()).toBe("completed")
  })

  test("eval mode: GOAL_MET on first iteration completes the goal", async () => {
    registry.add(new SeqParticipant(makePersona("worker"), ["(done)"]))
    const planner = new SeqParticipant(makePersona("planner"), ["GOAL_MET — verified the artifact exists"])
    registry.add(planner)
    priv(room).fallbackAgentId = null // keep iteration semantics clean
    await room.init()

    room.submitGoal("@worker build the artifact", { mode: "eval", maxIterations: 5 })
    await settle()

    expect(room.getGoalStatus()).toBe("completed")
    expect(priv(room).goalIteration).toBe(1)
    // The evaluator received exactly one goal_eval injection.
    const evalMsgs = planner.customMessages.filter(m => m.customType === "goal_eval")
    expect(evalMsgs).toHaveLength(1)
    expect(evalMsgs[0].content).toContain("GOAL EVALUATION")
  })

  test("eval mode: dispatch then GOAL_MET on second iteration", async () => {
    const worker = new SeqParticipant(makePersona("worker"), ["(done)"])
    registry.add(worker)
    // iter1: not met, dispatch worker; iter2: met.
    const planner = new SeqParticipant(makePersona("planner"), [
      "Not met yet — the file is empty. @worker write the content.",
      "GOAL_MET — the file now has content, verified by read.",
    ])
    registry.add(planner)
    priv(room).fallbackAgentId = null
    await room.init()

    room.submitGoal("@worker create the file", { mode: "eval", maxIterations: 5 })
    await settle(500)

    expect(room.getGoalStatus()).toBe("completed")
    expect(priv(room).goalIteration).toBe(2)
    // Worker ran once in the initial drain + once when dispatched in iter1.
    expect(worker.callCount).toBe(2)
  })

  test("eval mode: exhausting maxIterations fails the goal", async () => {
    registry.add(new SeqParticipant(makePersona("worker"), ["(done)"]))
    const planner = new SeqParticipant(makePersona("planner"), [
      "Still not met, attempt one — keep refining.",
      "Still not met, attempt two — almost there.",
      "Still not met, attempt three — not yet.",
    ])
    registry.add(planner)
    priv(room).fallbackAgentId = null
    await room.init()

    room.submitGoal("@worker do the impossible", { mode: "eval", maxIterations: 3 })
    await settle(600)

    expect(room.getGoalStatus()).toBe("failed")
    expect(priv(room).goalIteration).toBe(3)
    const failed = roomEvents.find(e => e.type === "goal-failed")
    expect(failed?.reason).toBe("max-iterations")
  })

  test("eval mode: missing evaluator falls back to auto-completion", async () => {
    registry.add(new SeqParticipant(makePersona("worker"), ["(done)"]))
    // No "planner" persona in the registry.
    await room.init()

    room.submitGoal("@worker do it", { mode: "eval", evaluator: "planner", maxIterations: 5 })
    await settle()

    expect(room.getGoalStatus()).toBe("completed")
    expect(priv(room).goalIteration).toBe(0) // loop never ran
  })

  test("eval mode: emits goal-eval events per iteration", async () => {
    registry.add(new SeqParticipant(makePersona("worker"), ["(done)"]))
    const planner = new SeqParticipant(makePersona("planner"), [
      "Not met — @worker keep going.",
      "GOAL_MET done.",
    ])
    registry.add(planner)
    priv(room).fallbackAgentId = null
    await room.init()

    room.submitGoal("@worker iterate", { mode: "eval", maxIterations: 5 })
    await settle(500)

    const evalEvents = roomEvents.filter(e => e.type === "goal-eval")
    expect(evalEvents.map(e => e.iteration)).toEqual([1, 2])
  })

  test("evaluator-as-fallback: no double invocation, iteration count stays accurate", async () => {
    // Regression guard for the production interaction: planner is BOTH the
    // goalEvaluator AND the fallbackAgentId. Without suppression, a normal worker
    // completion (no @mention) would trigger fallback routing back to the planner,
    // doubling invocations per iteration and inflating goalIteration.
    const worker = new SeqParticipant(makePersona("worker"), ["(done)"])
    registry.add(worker)
    // iter1: dispatch worker (no GOAL_MET); iter2: GOAL_MET.
    const planner = new SeqParticipant(makePersona("planner"), [
      "Not met — the output is missing. @worker produce it.",
      "GOAL_MET — verified the output exists.",
    ])
    registry.add(planner)
    // Planner is the fallback agent (production default) — do NOT null it.
    priv(room).fallbackAgentId = "planner"
    await room.init()

    room.submitGoal("@worker produce output", { mode: "eval", maxIterations: 10 })
    await settle(600)

    expect(room.getGoalStatus()).toBe("completed")
    // Exactly 2 eval iterations — fallback suppression prevented a spurious
    // third planner invocation that would have inflated the count.
    expect(priv(room).goalIteration).toBe(2)
    // Planner ran exactly once per eval iteration (2 total), not 2× per iteration.
    expect(planner.callCount).toBe(2)
    // The eval loop restored the fallback agent on exit.
    expect(priv(room).fallbackAgentId).toBe("planner")
    // Only goal_eval injections reached the planner — no routing_fallback /
    // circuit_breaker_recovery messages with their misleading "it looped" framing.
    expect(planner.customMessages.every(m => m.customType === "goal_eval")).toBe(true)
  })

  test("custom evaluator id is honored", async () => {
    registry.add(new SeqParticipant(makePersona("worker"), ["(done)"]))
    const auditor = new SeqParticipant(makePersona("auditor"), ["GOAL_MET verified"])
    registry.add(auditor)
    priv(room).fallbackAgentId = null
    await room.init()

    room.submitGoal("@worker build", { mode: "eval", evaluator: "auditor", maxIterations: 5 })
    await settle()

    expect(room.getGoalStatus()).toBe("completed")
    expect(auditor.customMessages.some(m => m.customType === "goal_eval")).toBe(true)
  })
})

// ── GOAL_MET keyword detection ────────────────────────────────────────────────

describe("GOAL_MET keyword detection", () => {
  const detect = (text: string): boolean => /\bGOAL[\s_-]?MET\b/i.test(text)

  test("matches canonical and variant spellings", () => {
    expect(detect("GOAL_MET")).toBe(true)
    expect(detect("GOAL MET")).toBe(true)
    expect(detect("goal-met")).toBe(true)
    expect(detect("goal_met")).toBe(true)
    expect(detect("...so I conclude GOAL_MET here.")).toBe(true)
  })

  test("does not match unrelated text", () => {
    expect(detect("the goal is not met yet")).toBe(false)
    expect(detect("goalkeeper meeting")).toBe(false)
    expect(detect("metgoal")).toBe(false)
  })
})
