// Supervised routing — builder smoke tests for the wiring (phase 1).
// The full matrix (ask_user interplay, back-compat load, HTTP validation)
// is task #5 (tester). These cover the core control paths end-to-end with a
// stubbed decision runner: accept / transfer / refuse+return-to-sender /
// anti-ping-pong cap / degradation / supervisor auto-accept / abort-in-flight
// inertness (the ghost-micro-turn race flagged in review).

import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
import type { Persona } from "../types.js"
import type { SupervisorOutcome } from "../route-supervisor.js"

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

class MockParticipant {
  persona: Persona
  active = true
  parallel = false
  status = "idle"
  cursor = 0
  calls = 0
  customMessages: Array<{ customType: string; content: string }> = []
  /** Handoff target this agent registers on EVERY run (stubborn proposer). */
  handoffTo: string | null = null
  private registry: MockRegistry

  constructor(id: string, registry: MockRegistry, handoffTo: string | null = null) {
    this.persona = { id, name: id, color: "#000", icon: "🤖", tools: [], systemPrompt: "" }
    this.registry = registry
    this.handoffTo = handoffTo
  }

  async run(_text: string) {
    this.calls++
    if (this.handoffTo) this.registry.register(this.persona.id, this.handoffTo)
    return { text: `(${this.persona.id} done)`, activity: [], reasoning: undefined, question: undefined }
  }
  async followUp(t: string) { return this.run(t) }
  async abort() {}
  async sendCustomMessage(m: { customType: string; content: string; display: boolean }, _o?: unknown) {
    this.customMessages.push({ customType: m.customType, content: m.content })
  }
  getContextUsage() { return undefined }
  getSessionStats() { return undefined }
  getAvailableThinkingLevels() { return [] }
}

class MockRegistry {
  private parts = new Map<string, MockParticipant>()
  onChange: (() => void) | null = null
  private pendingHandoff = new Map<string, string>()
  add(p: MockParticipant) { this.parts.set(p.persona.id, p) }
  get(id: string) { return this.parts.get(id) }
  has(id: string) { return this.parts.has(id) }
  roster() { return [...this.parts.values()] }
  activeIds(): string[] { return [...this.parts.values()].filter((p) => p.active).map((p) => p.persona.id) }
  register(from: string, to: string): void { this.pendingHandoff.set(from, to) }
  takeHandoff(from: string): string | undefined {
    const to = this.pendingHandoff.get(from)
    this.pendingHandoff.delete(from)
    return to
  }
  peekHandoff(from: string): string | undefined { return this.pendingHandoff.get(from) }
  personaStates() { return [...this.parts.values()].map((p) => ({ ...p.persona, active: p.active })) }
  broadcastRoster() {}
  reset(_s: unknown[]) {}
  setActive(id: string, active: boolean) { const p = this.parts.get(id); if (p) p.active = active }
  kick(id: string) { this.parts.delete(id) }
  disposeAll() { this.parts.clear() }
  isAllowedModel(_m: string) { return true }
  setDefaultThinkingLevel(_l: string) {}
  setAllowCloud(_v: boolean) {}
  setCompactionReserveTokens(_n: number) {}
  get resolvedModel() { return {} }
}

class MockStore {
  async init() {}
  async write() {}
  async read() { return null }
  async list() { return [] }
  async remove(_id: string) {}
}

/** Poke Room privates (established pattern — see goal-eval tests). */
const priv = (r: Room) => r as unknown as {
  supervisorRunner: (opts: { prompt: string; validTargetIds: string[]; registerAbort?: (a: () => void) => void }) => Promise<SupervisorOutcome>
  pendingRoute: unknown
  refusedRoutes: Set<string>
  supervisorAbort: (() => void) | null
}

describe("supervised routing (stubbed runner)", () => {
  let hub: SseHub
  let registry: MockRegistry
  let room: Room
  let runnerCalls: Array<{ prompt: string; validTargetIds: string[] }>

  const stubRunner = (outcome: SupervisorOutcome | (() => SupervisorOutcome)) => {
    priv(room).supervisorRunner = async (opts) => {
      runnerCalls.push({ prompt: opts.prompt, validTargetIds: opts.validTargetIds })
      return typeof outcome === "function" ? outcome() : outcome
    }
  }

  beforeEach(async () => {
    hub = new SseHub(1)
    registry = new MockRegistry()
    room = new Room(registry as never, hub, new MockStore() as never, [])
    runnerCalls = []
    await room.init()
    room.setRoutingMode("supervised")
    // Default fallback is "planner" — irrelevant noise for most tests here.
    room.setFallbackAgent(null)
  })

  afterEach(async () => {
    await room.abortCurrent()
  })

  test("accept: proposal dispatches, supervisor trace lands in the transcript", async () => {
    const planner = new MockParticipant("planner", registry)
    const builder = new MockParticipant("builder", registry, "tester")
    const tester = new MockParticipant("tester", registry)
    registry.add(planner); registry.add(builder); registry.add(tester)
    stubRunner({ decision: { verdict: "accept", reason: "right next seat" } })

    room.submit("@builder go")
    await sleep(300)

    expect(builder.calls).toBe(1)
    expect(tester.calls).toBe(1)
    expect(runnerCalls).toHaveLength(1)
    const trace = room.getTranscript().find((e) => e.author === "planner" && e.text.includes("✓"))
    expect(trace?.text).toContain("@builder → @tester")
    expect(trace?.text).toContain("right next seat")
    expect(priv(room).pendingRoute).toBeNull()
  })

  test("transfer: redirected target runs, proposed one does not; proposers excluded from valid targets", async () => {
    registry.add(new MockParticipant("planner", registry))
    const builder = new MockParticipant("builder", registry, "tester")
    const tester = new MockParticipant("tester", registry)
    const auditor = new MockParticipant("auditor", registry)
    registry.add(builder); registry.add(tester); registry.add(auditor)
    stubRunner({ decision: { verdict: "transfer", targetIds: ["auditor"], reason: "review first" } })

    room.submit("@builder go")
    await sleep(300)

    expect(auditor.calls).toBe(1)
    expect(tester.calls).toBe(0)
    expect(runnerCalls[0].validTargetIds).not.toContain("builder")
    const trace = room.getTranscript().find((e) => e.text.includes("↪"))
    expect(trace?.text).toContain("@auditor")
  })

  test("transfer with duplicated targetIds runs the target exactly once (F1, dispatch layer)", async () => {
    registry.add(new MockParticipant("planner", registry))
    const builder = new MockParticipant("builder", registry, "tester")
    const tester = new MockParticipant("tester", registry)
    const auditor = new MockParticipant("auditor", registry)
    registry.add(builder); registry.add(tester); registry.add(auditor)
    // Bypass the tool-layer de-dupe on purpose: the stub feeds duplicates
    // straight into the dispatch layer, which must de-dupe independently
    // (also covers the human redirect path).
    stubRunner({ decision: { verdict: "transfer", targetIds: ["auditor", "auditor"], reason: "x" } })

    room.submit("@builder go")
    await sleep(300)

    expect(auditor.calls).toBe(1)
  })

  test("refuse: return-to-sender with reason injected; stubborn re-proposal hits the cap and drops (no fallback)", async () => {
    registry.add(new MockParticipant("planner", registry))
    const builder = new MockParticipant("builder", registry, "tester") // re-proposes every run
    const tester = new MockParticipant("tester", registry)
    registry.add(builder); registry.add(tester)
    stubRunner({ decision: { verdict: "refuse", reason: "auditor has not seen src yet" } })

    room.submit("@builder go")
    await sleep(400)

    // First run proposed → refused → re-run (2 calls) → identical re-proposal
    // capped (fallback null → dropped) → drain ends. No third review round.
    expect(builder.calls).toBe(2)
    expect(tester.calls).toBe(0)
    expect(runnerCalls).toHaveLength(1)
    const refusal = builder.customMessages.find((m) => m.customType === "route_refusal")
    expect(refusal?.content).toContain("auditor has not seen src yet")
    expect(refusal?.content).toContain("@tester")
    const trace = room.getTranscript().find((e) => e.text.includes("✗"))
    expect(trace?.text).toContain("refused")
    expect(priv(room).pendingRoute).toBeNull()
  })

  test("refuse cap escape routes to the fallback agent when one is set", async () => {
    const planner = new MockParticipant("planner", registry)
    const builder = new MockParticipant("builder", registry, "tester")
    const tester = new MockParticipant("tester", registry)
    registry.add(planner); registry.add(builder); registry.add(tester)
    room.setFallbackAgent("planner")
    stubRunner({ decision: { verdict: "refuse", reason: "not yet" } })

    room.submit("@builder go")
    await sleep(400)

    expect(builder.calls).toBe(2)
    expect(tester.calls).toBe(0)
    expect(planner.calls).toBeGreaterThanOrEqual(1) // cap escape → fallback seat
  })

  test("cap memory clears at end of turn — next turn's identical proposal is reviewed again", async () => {
    registry.add(new MockParticipant("planner", registry))
    const builder = new MockParticipant("builder", registry, "tester")
    const tester = new MockParticipant("tester", registry)
    registry.add(builder); registry.add(tester)
    stubRunner({ decision: { verdict: "refuse", reason: "no" } })
    room.submit("@builder go")
    await sleep(400)
    expect(priv(room).refusedRoutes.size).toBe(0) // cleared by endTurn

    stubRunner({ decision: { verdict: "accept", reason: "ok now" } })
    room.submit("@builder again")
    await sleep(300)
    expect(tester.calls).toBe(1) // reviewed (not capped) and accepted
  })

  test("degradation = dispatch, never stall: null decision approves the set with a notice", async () => {
    registry.add(new MockParticipant("planner", registry))
    const builder = new MockParticipant("builder", registry, "tester")
    const tester = new MockParticipant("tester", registry)
    registry.add(builder); registry.add(tester)
    stubRunner({ decision: null, degraded: "supervisor turn failed: boom" })

    room.submit("@builder go")
    await sleep(300)

    expect(tester.calls).toBe(1) // dispatched as proposed
    expect(priv(room).pendingRoute).toBeNull()
  })

  test("no active supervisor: hop degrades to auto without invoking the runner", async () => {
    registry.add(new MockParticipant("planner", registry))
    const builder = new MockParticipant("builder", registry, "tester")
    const tester = new MockParticipant("tester", registry)
    registry.add(builder); registry.add(tester)
    registry.setActive("planner", false)
    stubRunner({ decision: { verdict: "refuse", reason: "should never be asked" } })

    room.submit("@builder go")
    await sleep(300)

    expect(tester.calls).toBe(1)
    expect(runnerCalls).toHaveLength(0)
  })

  test("no one supervises the supervisor: its own proposals auto-accept without the runner", async () => {
    const planner = new MockParticipant("planner", registry, "builder")
    const builder = new MockParticipant("builder", registry)
    registry.add(planner); registry.add(builder)
    stubRunner({ decision: { verdict: "refuse", reason: "should never be asked" } })

    room.submit("@planner go")
    await sleep(300)

    expect(builder.calls).toBe(1)
    expect(runnerCalls).toHaveLength(0)
  })

  test("abort while a decision is in flight: outcome is inert, abort handle is pulled", async () => {
    registry.add(new MockParticipant("planner", registry))
    const builder = new MockParticipant("builder", registry, "tester")
    const tester = new MockParticipant("tester", registry)
    registry.add(builder); registry.add(tester)

    let aborted = false
    let release!: (o: SupervisorOutcome) => void
    priv(room).supervisorRunner = async (opts) => {
      opts.registerAbort?.(() => { aborted = true })
      return new Promise<SupervisorOutcome>((r) => { release = r })
    }

    room.submit("@builder go")
    await sleep(200) // builder ran, decision now in flight
    expect(builder.calls).toBe(1)

    await room.abortCurrent()
    expect(aborted).toBe(true) // the ephemeral session was told to stop
    expect(priv(room).supervisorAbort).toBeNull()

    // The ghost decision arrives AFTER the stop — must be a no-op.
    release({ decision: { verdict: "accept", reason: "too late" } })
    await sleep(200)
    expect(tester.calls).toBe(0)
    expect(priv(room).pendingRoute).toBeNull()
  })

  test("semi mode is untouched: proposals still pause for the human, runner never runs", async () => {
    registry.add(new MockParticipant("planner", registry))
    const builder = new MockParticipant("builder", registry, "tester")
    const tester = new MockParticipant("tester", registry)
    registry.add(builder); registry.add(tester)
    room.setRoutingMode("semi")
    stubRunner({ decision: { verdict: "accept", reason: "nope" } })

    room.submit("@builder go")
    await sleep(300)

    expect(tester.calls).toBe(0)
    expect(runnerCalls).toHaveLength(0)
    expect(room.getPendingRoute()?.proposals).toEqual([
      { from: "builder", target: "tester", targetName: "tester" },
    ])
  })
})
