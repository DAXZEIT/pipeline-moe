import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
import type { Persona, PersonaState } from "../types.js"

// F7 (knownissues.md): "if the user is stopping a model during his turn, the
// entirety of his work is gone from the room." Root cause was code-confirmed
// in room.ts's executeAgent(): `if (this.aborted) return null` discarded a
// real, populated TurnResult purely because the room's abort flag was set —
// even though session.prompt()/followUp() resolve normally (not by throwing)
// on both user-abort and terminal provider error, tagging the assistant
// message's stopReason instead. These tests prove the salvage path: a real
// reply survives an abort or a provider failure, lands in the transcript with
// an explicit marker, and is inert for routing (no chain/pause triggered).

/** A participant whose run()/followUp() blocks until openGate() is called,
 *  then resolves with a scripted result — lets a test abort mid-turn and
 *  control exactly what "streamed" before the stop. */
class GateParticipant {
  persona: Persona
  active = true
  parallel = false
  status: "idle" | "active" | "thinking" | "working" = "idle"
  cursor = 0
  private release!: () => void
  private gate: Promise<void>
  private result: { text: string; activity: never[]; reasoning?: string; question?: string; stopReason?: "aborted" | "error"; errorMessage?: string }

  constructor(persona: Persona, result: { text: string; stopReason?: "aborted" | "error"; errorMessage?: string; question?: string }) {
    this.persona = persona
    this.gate = new Promise<void>((r) => { this.release = r })
    this.result = { activity: [], ...result }
  }

  async run(_text: string) {
    await this.gate
    return this.result
  }
  async followUp(_text: string) { return this.run(_text) }
  async abort() { this.release() }
  openGate() { this.release() }

  getContextUsage() { return undefined }
  getSessionStats() { return undefined }
  getAvailableThinkingLevels() { return [] }
}

/** A plain participant that resolves immediately — used to prove a
 *  chained/proposed handoff target never actually runs. */
class MockParticipant {
  persona: Persona
  active = true
  parallel = false
  status: "idle" | "active" | "thinking" | "working" = "idle"
  cursor = 0
  ran = false
  constructor(persona: Persona) { this.persona = persona }
  async run(_text: string) {
    this.ran = true
    return { text: "(should not have run)", activity: [], reasoning: undefined, question: undefined }
  }
  async followUp(_text: string) { return this.run(_text) }
  getContextUsage() { return undefined }
  getSessionStats() { return undefined }
  getAvailableThinkingLevels() { return [] }
}

class MockRegistry {
  private parts = new Map<string, MockParticipant | GateParticipant>()
  onChange: (() => void) | null = null
  private pendingHandoff = new Map<string, string>()

  add(p: MockParticipant | GateParticipant) { this.parts.set(p.persona.id, p) }
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
  activeIds(): string[] { return this.activeParticipants().map((p) => p.persona.id) }
  register(from: string, to: string): void { this.pendingHandoff.set(from, to) }
  takeHandoff(from: string): string | undefined {
    const to = this.pendingHandoff.get(from)
    this.pendingHandoff.delete(from)
    return to
  }
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

describe("F7: turn salvage on abort / provider failure", () => {
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

  test("abortCurrent() mid-turn: the real partial reply is posted, not discarded", async () => {
    const agent = new GateParticipant(makePersona("builder"), { text: "partial work: wrote 40 of 100 lines" })
    registry.add(agent)
    await room.init()

    room.submit("@builder do something long")
    await new Promise<void>((r) => setTimeout(r, 30)) // let the turn start and block on the gate

    await room.abortCurrent()
    agent.openGate() // release — executeAgent now sees this.aborted=true
    await new Promise<void>((r) => setTimeout(r, 50))

    const transcript = room.getTranscript()
    const posted = transcript.find((e) => e.author === "builder")
    expect(posted).toBeDefined()
    expect(posted!.text).toContain("partial work: wrote 40 of 100 lines")
    expect(posted!.text).toContain("interrupted")
  })

  test("provider error (no explicit abort): the partial reply is posted with a failed marker", async () => {
    const agent = new GateParticipant(makePersona("builder"), {
      text: "wrote 12 lines before the 529",
      stopReason: "error",
      errorMessage: "upstream overloaded (529), retries exhausted",
    })
    registry.add(agent)
    await room.init()

    room.submit("@builder do something")
    await new Promise<void>((r) => setTimeout(r, 30))
    agent.openGate() // resolves on its own — nobody called abortCurrent()
    await new Promise<void>((r) => setTimeout(r, 50))

    const transcript = room.getTranscript()
    const posted = transcript.find((e) => e.author === "builder")
    expect(posted).toBeDefined()
    expect(posted!.text).toContain("wrote 12 lines before the 529")
    expect(posted!.text).toContain("failed")
    expect(posted!.text).toContain("upstream overloaded (529), retries exhausted")
  })

  test("a salvaged reply is inert for routing: an interrupted turn does not chain to a proposed target", async () => {
    // The reply text contains a mention-shaped string that a normal completed
    // turn's proposeChain/resolveTargets would act on — proving the salvage
    // path skips chaining entirely, not just skips reading a question field.
    const builder = new GateParticipant(makePersona("builder"), { text: "@auditor please review this" })
    const auditor = new MockParticipant(makePersona("auditor"))
    registry.add(builder)
    registry.add(auditor)
    await room.init()

    room.submit("@builder do something")
    await new Promise<void>((r) => setTimeout(r, 30))

    await room.abortCurrent()
    builder.openGate()
    await new Promise<void>((r) => setTimeout(r, 50))

    expect(auditor.ran).toBe(false)
    expect(room.isBusy()).toBe(false)
  })

  test("a salvaged reply's question field is not treated as a real pause", async () => {
    const agent = new GateParticipant(makePersona("builder"), {
      text: "partial — was mid-question",
      question: "should I continue?",
    })
    registry.add(agent)
    await room.init()

    room.submit("@builder do something")
    await new Promise<void>((r) => setTimeout(r, 30))

    await room.abortCurrent()
    agent.openGate()
    await new Promise<void>((r) => setTimeout(r, 50))

    // Room did not freeze waiting for an answer to a question that was never
    // really asked as a pause — it's a room that finished aborting.
    expect(room.isBusy()).toBe(false)
  })
})
