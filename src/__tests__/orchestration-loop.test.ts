import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
import { createAskOrchestratorToolDefinition } from "../custom-tools/ask-orchestrator.js"
import { createAnswerRoomToolDefinition } from "../custom-tools/answer-room.js"
import { buildCustomTools } from "../custom-tools/index.js"
import type { ParentLink } from "../orchestrator.js"
import type { Conversation, ConversationMeta, Persona, PersonaState } from "../types.js"

// The closed orchestration loop (dax, 2026-07-09): a spawned sub-room reports
// back into its parent room when its goal resolves (onGoalResolved →
// injectOrchestratorReport), and its agents can escalate mid-goal via
// ask_orchestrator — which pauses the sub-room exactly like ask_user until
// the parent answers via answer_room. All room-level behavior is tested
// against a REAL Room.

type Activity = Array<{ toolCallId: string; toolName: string; args: Record<string, string>; status: "ok" | "error"; ts: number }>
type RunResult = { text: string; activity: Activity; question?: string }

class MockParticipant {
  persona: Persona
  active = true
  parallel = false
  status: "idle" | "active" | "thinking" | "working" = "idle"
  cursor = 0

  private results: RunResult[] = []

  constructor(persona: Persona, private execLog: string[]) {
    this.persona = persona
  }

  queueResult(r: { text: string; question?: string }): this {
    this.results.push({
      text: r.text,
      activity: r.question
        ? [{ toolCallId: "t1", toolName: "ask_orchestrator", args: { question: r.question }, status: "ok", ts: Date.now() }]
        : [],
      question: r.question,
    })
    return this
  }

  private async exec(): Promise<RunResult> {
    this.execLog.push(this.persona.id)
    return this.results.shift() ?? { text: "ok", activity: [] }
  }

  async run(_text: string, _images?: string[]) {
    return this.exec()
  }
  async followUp(_text: string, _images?: string[]) {
    return this.exec()
  }
  async sendCustomMessage(_msg: unknown, _opts?: unknown) {}
  async abort() {}
  dispose() {}
}

class MockRegistry {
  private participants = new Map<string, MockParticipant>()
  onChange: (() => void) | null = null
  /** Mirrors the real Registry's HandoffSink — no test here registers a
   *  handoff (dispatch goes via ask_orchestrator/answer_room, not @-mention),
   *  but proposeChain() calls takeHandoff() unconditionally on every reply,
   *  so it must exist. */
  private pendingHandoff = new Map<string, string>()
  activeParticipants() {
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
    return [...this.participants.values()].map((p) => ({ ...p.persona, active: p.active, parallel: p.parallel }))
  }
  get(id: string) {
    return this.participants.get(id)
  }
  has(id: string) {
    return this.participants.has(id)
  }
  roster() {
    return [...this.participants.values()].map((p) => ({
      id: p.persona.id, name: p.persona.name, color: p.persona.color, icon: p.persona.icon,
      tools: p.persona.tools, active: p.active, status: p.status, parallel: p.parallel,
    }))
  }
  broadcastRoster() {}
  async reset(_states: PersonaState[]) {}
  setActive() {}
  kick() {}
  disposeAll() {}
  addParticipant(p: MockParticipant) {
    this.participants.set(p.persona.id, p)
  }
}

class MockStore {
  async init() {}
  async list(): Promise<ConversationMeta[]> { return [] }
  async read(_id: string): Promise<Conversation | null> { return null }
  async write(_conv: Conversation) {}
  async remove(_id: string) {}
}

function makePersona(id: string): Persona {
  return { id, name: id, color: "#000", icon: "🤖", tools: [], systemPrompt: "" }
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as { text: string }).text
}

describe("onGoalResolved — the sub-room's return path", () => {
  let registry: MockRegistry
  let room: Room
  let execLog: string[]

  beforeEach(() => {
    registry = new MockRegistry()
    execLog = []
    room = new Room(registry as any, new SseHub(1), new MockStore() as any, [])
    room.setFallbackAgent(null)
  })

  afterEach(async () => {
    await room.abortCurrent()
  })

  test("fires once with 'completed' when an auto-mode goal drains", async () => {
    registry.addParticipant(new MockParticipant(makePersona("builder"), execLog).queueResult({ text: "done" }))
    const resolutions: string[] = []
    room.onGoalResolved = (status) => resolutions.push(status)

    room.submitGoal("@builder do the thing")
    await new Promise((r) => setTimeout(r, 300))

    expect(resolutions).toEqual(["completed"])
    expect(room.getGoalStatus()).toBe("completed")
  })

  test("fires with 'failed' when an eval goal exhausts its iterations", async () => {
    const evaluator = new MockParticipant(makePersona("auditor"), execLog)
    evaluator.queueResult({ text: "starting" }) // initial drain
    evaluator.queueResult({ text: "not there yet" }) // eval pass 1
    evaluator.queueResult({ text: "still not" }) // eval pass 2
    registry.addParticipant(evaluator)
    const resolutions: string[] = []
    room.onGoalResolved = (status) => resolutions.push(status)

    room.submitGoal("@auditor verify the thing", { mode: "eval", evaluator: "auditor", maxIterations: 2 })
    await new Promise((r) => setTimeout(r, 500))

    expect(resolutions).toEqual(["failed"])
    expect(room.getGoalStatus()).toBe("failed")
  })

  test("fires with 'completed' when the evaluator declares GOAL_MET", async () => {
    const evaluator = new MockParticipant(makePersona("auditor"), execLog)
    evaluator.queueResult({ text: "starting" })
    evaluator.queueResult({ text: "verified everything.\nGOAL_MET" })
    registry.addParticipant(evaluator)
    const resolutions: string[] = []
    room.onGoalResolved = (status) => resolutions.push(status)

    room.submitGoal("@auditor verify", { mode: "eval", evaluator: "auditor", maxIterations: 5 })
    await new Promise((r) => setTimeout(r, 500))

    expect(resolutions).toEqual(["completed"])
  })
})

describe("injectOrchestratorReport — waking the spawner in the parent room", () => {
  let registry: MockRegistry
  let room: Room
  let execLog: string[]
  let messages: Array<{ author: string; text: string }>

  beforeEach(() => {
    registry = new MockRegistry()
    execLog = []
    messages = []
    const hub = new SseHub(1)
    const orig = hub.broadcast.bind(hub)
    hub.broadcast = (event, data) => {
      if (event === "message") messages.push(data as { author: string; text: string })
      orig(event, data)
    }
    room = new Room(registry as any, hub, new MockStore() as any, [])
    room.setFallbackAgent(null)
  })

  afterEach(async () => {
    await room.abortCurrent()
  })

  test("posts the report and triggers the target agent's turn", async () => {
    const planner = new MockParticipant(makePersona("planner"), execLog).queueResult({ text: "integrating the result" })
    registry.addParticipant(planner)

    room.injectOrchestratorReport("📬 Sub-room X — goal completed.", "planner")
    await new Promise((r) => setTimeout(r, 300))

    expect(messages.some((m) => m.author === "orchestrator" && m.text.includes("goal completed"))).toBe(true)
    expect(execLog).toEqual(["planner"])
    expect(messages.some((m) => m.author === "planner" && m.text === "integrating the result")).toBe(true)
  })

  test("is passive while the room is paused on a question — no turn hijack", async () => {
    const planner = new MockParticipant(makePersona("planner"), execLog)
    planner.queueResult({ text: "need input", question: "Which?" })
    registry.addParticipant(planner)

    room.submit("@planner go")
    await new Promise((r) => setTimeout(r, 200))
    expect(room.isBusy()).toBe(true) // paused

    room.injectOrchestratorReport("📬 Sub-room X — goal completed.", "planner")
    await new Promise((r) => setTimeout(r, 300))

    // Report is posted, but the planner did NOT run again (pause intact).
    expect(messages.some((m) => m.author === "orchestrator")).toBe(true)
    expect(execLog).toEqual(["planner"])
    expect(room.isBusy()).toBe(true)
  })
})

describe("ask_orchestrator pause inside a goal-eval loop", () => {
  test("eval loop pauses on the question, resumes on the answer, then completes", async () => {
    const registry = new MockRegistry()
    const execLog: string[] = []
    const room = new Room(registry as any, new SseHub(1), new MockStore() as any, [])
    room.setFallbackAgent(null)

    const evaluator = new MockParticipant(makePersona("auditor"), execLog)
    evaluator.queueResult({ text: "starting the loop" }) // initial drain
    evaluator.queueResult({ text: "blocked", question: "Which path?" }) // eval pass 1 → pause
    evaluator.queueResult({ text: "thanks — proceeding" }) // followUp with the answer
    evaluator.queueResult({ text: "GOAL_MET" }) // next eval pass
    registry.addParticipant(evaluator)

    room.submitGoal("@auditor iterate", { mode: "eval", evaluator: "auditor", maxIterations: 5 })
    await new Promise((r) => setTimeout(r, 500))

    // Paused mid-eval: goal still running, nothing generating.
    expect(room.getGoalStatus()).toBe("running")
    expect(room.isBusy()).toBe(true)
    expect(room.isGenerating()).toBe(false)

    // The orchestrator's answer arrives (answer_room → submit).
    room.submit("take path A")
    await new Promise((r) => setTimeout(r, 500))

    expect(room.getGoalStatus()).toBe("completed")
    await room.abortCurrent()
  })
})

describe("ask_orchestrator / answer_room tools", () => {
  test("ask_orchestrator delivers the question through the parent link", async () => {
    const reports: string[] = []
    const link: ParentLink = {
      parentRoomId: "default",
      parentAgentId: "planner",
      childRoomId: "room-sub1",
      childName: "audit-x",
      report: (text) => reports.push(text),
    }
    const tool = createAskOrchestratorToolDefinition(link, "builder")
    const res = await tool.execute("t1", { question: "Two viable paths — which one?" } as never, undefined as never, undefined as never, {} as never)

    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain("Two viable paths")
    expect(reports[0]).toContain('answer_room({ roomId: "room-sub1"')
    expect(textOf(res)).toContain("end your turn now")
  })

  test("answer_room submits into the target room via the orchestrator", async () => {
    const answered: Array<{ roomId: string; text: string }> = []
    const orchestrator = {
      spawnRoom: async () => ({ roomId: "x", name: "x", goalStatus: "running" }),
      checkRoom: () => ({ found: false, roomId: "x" }),
      stopRoom: async () => true,
      destroyRoom: async () => true,
      answerRoom: (roomId: string, text: string) => {
        answered.push({ roomId, text })
        return true
      },
    }
    const tool = createAnswerRoomToolDefinition(orchestrator)
    const res = await tool.execute("t1", { roomId: "room-sub1", text: "take path A" } as never, undefined as never, undefined as never, {} as never)

    expect(answered).toEqual([{ roomId: "room-sub1", text: "take path A" }])
    expect(textOf(res)).toContain('Delivered to room "room-sub1"')
  })

  test("ask_orchestrator only exists in rooms with a parent link", () => {
    const link: ParentLink = {
      parentRoomId: "default", parentAgentId: "planner", childRoomId: "sub", childName: "sub",
      report: () => {},
    }
    const withLink = buildCustomTools([], { parentLink: link, personaId: "builder" })
    const withoutLink = buildCustomTools([], { personaId: "builder" })
    expect(withLink.map((t) => t.name)).toContain("ask_orchestrator")
    expect(withoutLink.map((t) => t.name)).not.toContain("ask_orchestrator")
  })
})
