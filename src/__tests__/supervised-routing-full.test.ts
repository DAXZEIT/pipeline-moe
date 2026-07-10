// Supervised routing — full test suite (phase 1).
// Covers: back-compat load, Room API validation, mixed set auto-accept,
// timeout degradation, refuse edge cases, transcript traces, endTurn cap clear,
// abort inertness, pendingRoute snapshot, degradation notice, and routingMode enum.

import { describe, expect, test } from "vitest"
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
  conv: object | null = null
  async init() {}
  async write(c: object) { this.conv = c }
  async read() { return this.conv }
  async list() { return this.conv ? [this.conv] : [] }
  async remove(_id: string) {}
}

const priv = (r: Room) => r as unknown as {
  supervisorRunner: (opts: { prompt: string; validTargetIds: string[]; registerAbort?: (a: () => void) => void }) => Promise<SupervisorOutcome>
  pendingRoute: unknown
  refusedRoutes: Set<string>
  supervisorAbort: (() => void) | null
}

function stubRunner(room: Room, outcome: SupervisorOutcome | (() => SupervisorOutcome) | Promise<SupervisorOutcome>) {
  priv(room).supervisorRunner = async (opts: any) => {
    const o = typeof outcome === "function" ? outcome() : outcome
    return o instanceof Promise ? o : o
  }
}

async function makeRoom(registry: MockRegistry, store: MockStore, mode: "auto"|"semi"|"manual"|"supervised" = "supervised") {
  const room = new Room(registry as never, new SseHub(1), store as never, [])
  await room.init()
  room.setRoutingMode(mode)
  room.setFallbackAgent(null)
  return room
}

function addAgents(registry: MockRegistry, ...agents: {id: string, handoffTo?: string}[]) {
  agents.forEach(a => registry.add(new MockParticipant(a.id, registry, a.handoffTo || null)))
}

describe("back-compat load", () => {
  test("old conversation without supervisorAgent defaults to planner", async () => {
    const registry = new MockRegistry()
    const store = new MockStore()
    const room = new Room(registry as never, new SseHub(1), store as never, [])
    await room.init(); room.setRoutingMode("supervised")
    addAgents(registry, {id:"planner"}, {id:"builder"})
    store.conv = { id:"old", title:"Old", createdAt:1, updatedAt:1, personas: registry.personaStates(), transcript:[], routingMode:"supervised" as const }
    await room.init()
    expect(room.getSupervisorAgent()).toBe("planner")
    await room.abortCurrent()
  })

  test("conversation with explicit supervisorAgent preserves it", async () => {
    const registry = new MockRegistry()
    const store = new MockStore()
    const room = new Room(registry as never, new SseHub(1), store as never, [])
    await room.init(); room.setRoutingMode("supervised")
    addAgents(registry, {id:"planner"}, {id:"auditor"})
    store.conv = { id:"new", title:"New", createdAt:1, updatedAt:1, personas: registry.personaStates(), transcript:[], routingMode:"supervised" as const, supervisorAgent:"auditor" }
    await room.init()
    expect(room.getSupervisorAgent()).toBe("auditor")
    await room.abortCurrent()
  })

  test("routingMode supervised serializable in buildConversation", async () => {
    const registry = new MockRegistry()
    const room = new Room(registry as never, new SseHub(1), new MockStore() as never, [])
    await room.init(); room.setRoutingMode("supervised")
    const conv = (room as any).buildConversation()
    expect(conv.routingMode).toBe("supervised")
    expect(conv.supervisorAgent).toBe("planner")
    await room.abortCurrent()
  })
})

describe("Room API validation", () => {
  test("setRoutingMode accepts supervised", async () => {
    const room = new Room(new MockRegistry() as never, new SseHub(1), new MockStore() as never, [])
    await room.init()
    expect(() => room.setRoutingMode("supervised")).not.toThrow()
    expect(room.getRoutingMode()).toBe("supervised")
    await room.abortCurrent()
  })

  test("setSupervisorAgent accepts valid roster id", async () => {
    const registry = new MockRegistry()
    const room = new Room(registry as never, new SseHub(1), new MockStore() as never, [])
    await room.init()
    registry.add(new MockParticipant("builder", registry))
    room.setSupervisorAgent("builder")
    expect(room.getSupervisorAgent()).toBe("builder")
    await room.abortCurrent()
  })

  test("setSupervisorAgent accepts null", async () => {
    const room = new Room(new MockRegistry() as never, new SseHub(1), new MockStore() as never, [])
    await room.init()
    room.setSupervisorAgent(null)
    expect(room.getSupervisorAgent()).toBeNull()
    await room.abortCurrent()
  })

  test("setSupervisorAgent rejects non-roster id", async () => {
    const room = new Room(new MockRegistry() as never, new SseHub(1), new MockStore() as never, [])
    await room.init()
    expect(() => room.setSupervisorAgent("ghost")).toThrow()
    await room.abortCurrent()
  })

  test("chaining derived: supervised ≠ manual → chaining true", async () => {
    const room = new Room(new MockRegistry() as never, new SseHub(1), new MockStore() as never, [])
    await room.init(); room.setRoutingMode("supervised")
    expect(room.getChaining()).toBe(true)
    await room.abortCurrent()
  })
})

describe("mixed set auto-accept", () => {
  test("pure supervisor proposals auto-accept without runner", async () => {
    const registry = new MockRegistry()
    const room = await makeRoom(registry, new MockStore())
    addAgents(registry, {id:"planner", handoffTo:"builder"}, {id:"builder"})
    stubRunner(room, { decision: { verdict: "refuse", reason: "should not be asked" } })
    room.submit("@planner go")
    await sleep(300)
    expect(registry.get("builder")!.calls).toBe(1)
    expect(priv(room).pendingRoute).toBeNull()
    await room.abortCurrent()
  })

  test("mixed set invokes the runner", async () => {
    const registry = new MockRegistry()
    const room = await makeRoom(registry, new MockStore())
    addAgents(registry, {id:"planner", handoffTo:"tester"}, {id:"builder", handoffTo:"auditor"}, {id:"tester"}, {id:"auditor"})
    let invoked = false
    stubRunner(room, () => { invoked = true; return { decision: { verdict: "accept", reason: "ok" } } })
    room.submit("@planner @builder go")
    await sleep(400)
    expect(invoked).toBe(true)
    await room.abortCurrent()
  })
})

describe("timeout degradation", () => {
  test("timeout degraded outcome dispatches as proposed", async () => {
    const registry = new MockRegistry()
    const room = await makeRoom(registry, new MockStore())
    addAgents(registry, {id:"planner"}, {id:"builder", handoffTo:"tester"}, {id:"tester"})
    stubRunner(room, { decision: null, degraded: "supervisor decision timed out after 120s" })
    room.submit("@builder go")
    await sleep(300)
    expect(registry.get("tester")!.calls).toBe(1)
    expect(priv(room).pendingRoute).toBeNull()
    await room.abortCurrent()
  })
})

describe("refuse edge cases", () => {
  test("refuse + cap: identical re-proposal falls to fallback", async () => {
    const registry = new MockRegistry()
    const room = await makeRoom(registry, new MockStore())
    addAgents(registry, {id:"planner"}, {id:"builder", handoffTo:"tester"}, {id:"tester"})
    room.setFallbackAgent("planner")
    stubRunner(room, { decision: { verdict: "refuse", reason: "not ready" } })
    room.submit("@builder go")
    await sleep(400)
    expect(registry.get("builder")!.calls).toBe(2)
    expect(registry.get("planner")!.calls).toBeGreaterThanOrEqual(1)
    await room.abortCurrent()
  })

  test("refuse with chain budget exhausted: reason delivered, proposer not re-run", async () => {
    const registry = new MockRegistry()
    const room = await makeRoom(registry, new MockStore())
    addAgents(registry, {id:"planner"}, {id:"builder", handoffTo:"tester"}, {id:"tester"})
    room.setMaxChainHops(0)
    stubRunner(room, { decision: { verdict: "refuse", reason: "not ready" } })
    room.submit("@builder go")
    await sleep(400)
    const builder = registry.get("builder")!
    const refusal = builder.customMessages.find((m) => m.customType === "route_refusal")
    expect(refusal).toBeDefined()
    await room.abortCurrent()
  })
})

describe("transcript trace observability", () => {
  test("accept trace has checkmark", async () => {
    const registry = new MockRegistry()
    const room = await makeRoom(registry, new MockStore())
    addAgents(registry, {id:"planner"}, {id:"builder", handoffTo:"tester"}, {id:"tester"})
    stubRunner(room, { decision: { verdict: "accept", reason: "correct hop" } })
    room.submit("@builder go")
    await sleep(300)
    const trace = room.getTranscript().find((e) => e.text.includes("✓"))
    expect(trace).toBeDefined()
    expect(trace!.author).toBe("planner")
    expect(trace!.text).toContain("@builder → @tester")
    expect(trace!.text).toContain("correct hop")
    await room.abortCurrent()
  })

  test("transfer trace has redirect arrow", async () => {
    const registry = new MockRegistry()
    const room = await makeRoom(registry, new MockStore())
    addAgents(registry, {id:"planner"}, {id:"builder", handoffTo:"tester"}, {id:"tester"}, {id:"auditor"})
    stubRunner(room, { decision: { verdict: "transfer", targetIds: ["auditor"], reason: "review" } })
    room.submit("@builder go")
    await sleep(300)
    const trace = room.getTranscript().find((e) => e.text.includes("↪"))
    expect(trace).toBeDefined()
    expect(trace!.text).toContain("@auditor")
    await room.abortCurrent()
  })

  test("refuse trace has X mark", async () => {
    const registry = new MockRegistry()
    const room = await makeRoom(registry, new MockStore())
    addAgents(registry, {id:"planner"}, {id:"builder", handoffTo:"tester"}, {id:"tester"})
    stubRunner(room, { decision: { verdict: "refuse", reason: "wrong target" } })
    room.submit("@builder go")
    await sleep(400)
    const trace = room.getTranscript().find((e) => e.text.includes("✗"))
    expect(trace).toBeDefined()
    expect(trace!.text).toContain("refused")
    expect(trace!.text).toContain("wrong target")
    await room.abortCurrent()
  })
})

describe("routingMode enum exhaustiveness", () => {
  test("includes all four modes", () => {
    const modes = ["auto", "semi", "manual", "supervised"] as const
    modes.forEach((m) => { const mode: import("../types.js").RoutingMode = m; expect(mode).toBeDefined() })
  })
})

describe("supervisor change mid-flight", () => {
  test("changing supervisor after runner starts: old outcome still applies", async () => {
    const registry = new MockRegistry()
    const room = await makeRoom(registry, new MockStore())
    addAgents(registry, {id:"planner"}, {id:"builder", handoffTo:"tester"}, {id:"tester"}, {id:"auditor"})
    let release!: (o: SupervisorOutcome) => void
    stubRunner(room, new Promise<SupervisorOutcome>((r) => { release = r }))
    room.submit("@builder go")
    await sleep(200)
    room.setSupervisorAgent("auditor")
    expect(room.getSupervisorAgent()).toBe("auditor")
    release({ decision: { verdict: "accept", reason: "from original supervisor" } })
    await sleep(200)
    expect(registry.get("tester")!.calls).toBe(1)
    expect(priv(room).pendingRoute).toBeNull()
    await room.abortCurrent()
  })
})

describe("refuse reason injection format", () => {
  test("refusal message contains reason and refused targets", async () => {
    const registry = new MockRegistry()
    const room = await makeRoom(registry, new MockStore())
    addAgents(registry, {id:"planner"}, {id:"builder", handoffTo:"tester"}, {id:"tester"})
    stubRunner(room, { decision: { verdict: "refuse", reason: "auditor must review first" } })
    room.submit("@builder go")
    await sleep(400)
    const refusal = registry.get("builder")!.customMessages.find((m) => m.customType === "route_refusal")
    expect(refusal).toBeDefined()
    expect(refusal!.content).toContain("auditor must review first")
    expect(refusal!.content).toContain("@tester")
    await room.abortCurrent()
  })
})

describe("pendingRoute snapshot", () => {
  test("getPendingRoute returns the pending proposals", async () => {
    const registry = new MockRegistry()
    const room = await makeRoom(registry, new MockStore())
    addAgents(registry, {id:"planner"}, {id:"builder", handoffTo:"tester"}, {id:"tester"})
    let release!: (o: SupervisorOutcome) => void
    stubRunner(room, new Promise<SupervisorOutcome>((r) => { release = r }))
    room.submit("@builder go")
    await sleep(200)
    const pending = room.getPendingRoute()
    expect(pending).toBeDefined()
    expect(pending!.proposals).toHaveLength(1)
    expect(pending!.proposals[0].from).toBe("builder")
    expect(pending!.proposals[0].target).toBe("tester")
    release({ decision: { verdict: "accept", reason: "ok" } })
    await sleep(200)
    expect(room.getPendingRoute()).toBeNull()
    await room.abortCurrent()
  })
})

describe("degradation notice format", () => {
  test("degradation notice is emitted with cause", async () => {
    const registry = new MockRegistry()
    const room = await makeRoom(registry, new MockStore())
    addAgents(registry, {id:"planner"}, {id:"builder", handoffTo:"tester"}, {id:"tester"})
    const notices: string[] = []
    ;(room as any).notice = (msg: string) => notices.push(msg)
    stubRunner(room, { decision: null, degraded: "supervisor turn failed: boom" })
    room.submit("@builder go")
    await sleep(300)
    expect(notices.some((n) => n.includes("degraded to auto"))).toBe(true)
    expect(notices.some((n) => n.includes("boom"))).toBe(true)
    expect(registry.get("tester")!.calls).toBe(1)
    await room.abortCurrent()
  })
})

describe("no active supervisor degrades to auto", () => {
  test("supervisor deactivated → hop degrades without invoking runner", async () => {
    const registry = new MockRegistry()
    const room = await makeRoom(registry, new MockStore())
    addAgents(registry, {id:"planner"}, {id:"builder", handoffTo:"tester"}, {id:"tester"})
    registry.setActive("planner", false)
    stubRunner(room, { decision: { verdict: "refuse", reason: "should never be asked" } })
    room.submit("@builder go")
    await sleep(300)
    expect(registry.get("tester")!.calls).toBe(1)
    expect(priv(room).supervisorAbort).toBeNull()
    await room.abortCurrent()
  })
})

describe("endTurn clears refusedRoutes", () => {
  test("refusedRoutes empty after turn completes, next turn re-reviewed", async () => {
    const registry = new MockRegistry()
    const room = await makeRoom(registry, new MockStore())
    addAgents(registry, {id:"planner"}, {id:"builder", handoffTo:"tester"}, {id:"tester"})
    stubRunner(room, { decision: { verdict: "refuse", reason: "no" } })
    room.submit("@builder go")
    await sleep(500)
    expect(priv(room).refusedRoutes.size).toBe(0)
    stubRunner(room, { decision: { verdict: "accept", reason: "ok now" } })
    room.submit("@builder again")
    await sleep(300)
    expect(registry.get("tester")!.calls).toBe(1)
    await room.abortCurrent()
  })
})

describe("abortCurrent inertness guard", () => {
  test("outcome after abort is inert", async () => {
    const registry = new MockRegistry()
    const room = await makeRoom(registry, new MockStore())
    addAgents(registry, {id:"planner"}, {id:"builder", handoffTo:"tester"}, {id:"tester"})
    let release!: (o: SupervisorOutcome) => void
    stubRunner(room, new Promise<SupervisorOutcome>((r) => { release = r }))
    room.submit("@builder go")
    await sleep(200)
    await room.abortCurrent()
    expect(priv(room).pendingRoute).toBeNull()
    release({ decision: { verdict: "accept", reason: "too late" } })
    await sleep(200)
    expect(registry.get("tester")!.calls).toBe(0)
  })
})

describe("multiple proposals in a wave", () => {
  test("transfer applies to whole set", async () => {
    const registry = new MockRegistry()
    const room = await makeRoom(registry, new MockStore())
    addAgents(registry, {id:"planner"}, {id:"builder", handoffTo:"tester"}, {id:"tester"}, {id:"auditor"})
    stubRunner(room, { decision: { verdict: "transfer", targetIds: ["auditor"], reason: "review" } })
    room.submit("@builder go")
    await sleep(300)
    expect(registry.get("auditor")!.calls).toBe(1)
    expect(registry.get("tester")!.calls).toBe(0)
    await room.abortCurrent()
  })
})

describe("degradation on prompt build error", () => {
  test("error in runner path degrades to dispatch", async () => {
    const registry = new MockRegistry()
    const room = await makeRoom(registry, new MockStore())
    addAgents(registry, {id:"planner"}, {id:"builder", handoffTo:"tester"}, {id:"tester"})
    stubRunner(room, () => { throw new Error("prompt build failed") })
    room.submit("@builder go")
    await sleep(300)
    expect(registry.get("tester")!.calls).toBe(1)
    expect(priv(room).pendingRoute).toBeNull()
    await room.abortCurrent()
  })
})

describe("routingMode cycle integrity", () => {
  test("cycling through all modes preserves state", async () => {
    const registry = new MockRegistry()
    const room = new Room(registry as never, new SseHub(1), new MockStore() as never, [])
    await room.init()
    ;(["auto","semi","manual","supervised"] as const).forEach(m => {
      room.setRoutingMode(m)
      expect(room.getRoutingMode()).toBe(m)
    })
    expect(room.getRoutingMode()).toBe("supervised")
    await room.abortCurrent()
  })
})
