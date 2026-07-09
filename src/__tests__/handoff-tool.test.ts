import { describe, expect, test } from "vitest"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
import { buildCustomTools } from "../custom-tools/index.js"
import { createHandoffToolDefinition } from "../custom-tools/handoff.js"
import type { HandoffSink } from "../types.js"
import type { Conversation, ConversationMeta, Persona, PersonaState } from "../types.js"

// PLAN-bc8650af — the handoff tool replaces agent-reply @mention routing.
// KISS design: one tool, `to` is an enum of active agents minus self, no
// message payload. Closes F5: prose "@name" in an agent reply could not be
// told apart from a quote or description of someone else's handoff — the
// tool replaces that ambiguity with a menu pick instead of a text scan.

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as { text: string }).text
}

/* ── Unit: the handoff tool itself ────────────────────────────────────── */

function fakeSink(ids: string[]): HandoffSink & { registered: Array<{ from: string; to: string }> } {
  const registered: Array<{ from: string; to: string }> = []
  return {
    registered,
    activeIds: () => ids,
    register: (from, to) => { registered.push({ from, to }) },
  }
}

describe("handoff tool — schema", () => {
  test("enum excludes the calling persona itself", () => {
    const sink = fakeSink(["planner", "builder", "auditor"])
    const tool = createHandoffToolDefinition(sink, "builder")
    // TypeBox Type.Union(Type.Literal(...)) → JSON schema anyOf of const literals.
    const schema = tool.parameters as { properties: { to: { anyOf?: Array<{ const: string }> } } }
    const values = (schema.properties.to.anyOf ?? []).map((v) => v.const)
    expect(values.sort()).toEqual(["auditor", "planner"])
    expect(values).not.toContain("builder")
  })

  test("description tells the model prose @name does nothing", () => {
    const sink = fakeSink(["planner", "builder"])
    const tool = createHandoffToolDefinition(sink, "builder")
    expect(tool.description).toContain("@name")
    expect(tool.description.toLowerCase()).toContain("does not")
  })
})

describe("handoff tool — execute", () => {
  test("valid target registers and returns success", async () => {
    const sink = fakeSink(["planner", "builder"])
    const tool = createHandoffToolDefinition(sink, "builder")
    const result = await tool.execute("tc1", { to: "planner" }, undefined, undefined, {} as any)
    expect(sink.registered).toEqual([{ from: "builder", to: "planner" }])
    expect(textOf(result)).toContain("Handing off to @planner")
  })

  // F6 regression: terminate must be a hard boolean the pi-agent-core loop
  // checks (shouldTerminateToolBatch requires literal true on EVERY finalized
  // result in the batch), not just present-but-falsy or absent. A live 27B
  // model looped 13x on handoff before this fix because nothing told the
  // agent loop to stop re-invoking it — the "Your turn ends now" text was
  // advisory only. This is the contract our code must uphold; the loop's
  // actual enforcement of it lives in the vendored pi-agent-core dependency,
  // outside what a unit test here can exercise (see live re-validation instead).
  test("F6: success sets terminate:true so the agent loop can't be talked into continuing", async () => {
    const sink = fakeSink(["planner", "builder"])
    const tool = createHandoffToolDefinition(sink, "builder")
    const result = await tool.execute("tc1", { to: "planner" }, undefined, undefined, {} as any)
    expect(result.terminate).toBe(true)
  })

  test("F6: a retryable error does NOT set terminate — the model must get to correct itself in the same turn", async () => {
    const sink = fakeSink(["planner", "builder"])
    const tool = createHandoffToolDefinition(sink, "builder")
    const badSelf = await tool.execute("tc1", { to: "builder" }, undefined, undefined, {} as any)
    const badUnknown = await tool.execute("tc2", { to: "nonexistent" }, undefined, undefined, {} as any)
    expect(badSelf.terminate).not.toBe(true)
    expect(badUnknown.terminate).not.toBe(true)
  })

  test("rejects self-handoff with a correctable error, does not register", async () => {
    const sink = fakeSink(["planner", "builder"])
    const tool = createHandoffToolDefinition(sink, "builder")
    // A non-compliant model could still send its own id even though the
    // schema's enum excludes it — execute() must defend regardless.
    const result = await tool.execute("tc1", { to: "builder" }, undefined, undefined, {} as any)
    expect(sink.registered).toEqual([])
    expect(textOf(result)).toContain("handoff error")
    expect(textOf(result)).toContain("not a valid target")
  })

  test("rejects an unknown/hallucinated id, does not register", async () => {
    const sink = fakeSink(["planner", "builder"])
    const tool = createHandoffToolDefinition(sink, "builder")
    const result = await tool.execute("tc1", { to: "nonexistent" }, undefined, undefined, {} as any)
    expect(sink.registered).toEqual([])
    expect(textOf(result)).toContain("handoff error")
  })

  test("rejects a target that went inactive between build and execution", async () => {
    // Simulates roster staleness: the tool's enum snapshot included "auditor",
    // but by execution time the live roster no longer does (kicked/deactivated).
    const ids = ["planner", "builder", "auditor"]
    const sink: HandoffSink & { registered: unknown[] } = {
      registered: [],
      activeIds: () => ids,
      register: () => { throw new Error("must not be called") },
    }
    const tool = createHandoffToolDefinition(sink, "builder")
    ids.splice(ids.indexOf("auditor"), 1) // auditor goes inactive live
    const result = await tool.execute("tc1", { to: "auditor" }, undefined, undefined, {} as any)
    expect(textOf(result)).toContain("handoff error")
    expect(textOf(result)).toContain("planner") // still lists live valid choices
  })

  test("error message lists the live active choices", async () => {
    const sink = fakeSink(["planner", "builder", "auditor"])
    const tool = createHandoffToolDefinition(sink, "builder")
    const result = await tool.execute("tc1", { to: "ghost" }, undefined, undefined, {} as any)
    expect(textOf(result)).toContain("planner")
    expect(textOf(result)).toContain("auditor")
  })
})

/* ── buildCustomTools gating ───────────────────────────────────────────── */

describe("buildCustomTools — handoff gating", () => {
  test("omits handoff entirely with no other active agent (empty enum would be useless)", () => {
    const sink = fakeSink(["builder"]) // only self
    const tools = buildCustomTools([], { handoffSink: sink, personaId: "builder" })
    expect(tools.find((t) => t.name === "handoff")).toBeUndefined()
  })

  test("grants handoff automatically — NOT via the persona tool allowlist", () => {
    const sink = fakeSink(["planner", "builder"])
    // Empty allowlist passed to buildCustomTools — handoff must appear anyway,
    // exactly like the task board / ask_orchestrator (context-gated, not
    // allowlist-gated). This is also what sidesteps the F0 VALID_TOOLS class
    // of bug: handoff can never be silently stripped by an allowlist filter.
    const tools = buildCustomTools([], { handoffSink: sink, personaId: "builder" })
    expect(tools.map((t) => t.name)).toEqual(["handoff"])
  })

  test("no handoffSink in context → no handoff tool", () => {
    const tools = buildCustomTools([], { personaId: "builder" })
    expect(tools.find((t) => t.name === "handoff")).toBeUndefined()
  })
})

/* ── Room integration: real Room, mocked participants ─────────────────── */
// Mirrors the Mock harness pattern used across the other Room integration
// suites (ask-user.test.ts, turn-state.test.ts, etc).

class MockParticipant {
  persona: Persona
  active = true
  parallel = false
  status: "idle" | "active" | "thinking" | "working" = "idle"
  cursor = 0
  registry: MockRegistry | null = null

  private _nextResult: { text: string; handoffTo?: string } | null = null

  constructor(persona: Persona) {
    this.persona = persona
  }

  withResult(result: { text: string; handoffTo?: string }): this {
    this._nextResult = result
    return this
  }

  private async exec() {
    const result = this._nextResult ?? { text: "ok" }
    if (result.handoffTo) this.registry?.register(this.persona.id, result.handoffTo)
    return { text: result.text, activity: [], question: undefined }
  }

  async run(_text: string) { return this.exec() }
  async followUp(_text: string) { return this.exec() }
  async abort() {}
  dispose() {}
}

class MockRegistry {
  private participants = new Map<string, MockParticipant>()
  onChange: (() => void) | null = null
  private pendingHandoff = new Map<string, string>()

  activeParticipants(): MockParticipant[] {
    return [...this.participants.values()].filter((p) => p.active)
  }
  activeIds(): string[] { return this.activeParticipants().map((p) => p.persona.id) }
  register(from: string, to: string): void { this.pendingHandoff.set(from, to) }
  takeHandoff(from: string): string | undefined {
    const to = this.pendingHandoff.get(from)
    this.pendingHandoff.delete(from)
    return to
  }
  personaStates(): PersonaState[] {
    return [...this.participants.values()].map((p) => ({ ...p.persona, active: p.active, parallel: p.parallel }))
  }
  get(id: string) { return this.participants.get(id) }
  has(id: string) { return this.participants.has(id) }
  roster() {
    return [...this.participants.values()].map((p) => ({
      id: p.persona.id, name: p.persona.name, color: p.persona.color, icon: p.persona.icon,
      tools: p.persona.tools, active: p.active, status: p.status, parallel: p.parallel,
    }))
  }
  broadcastRoster() {}
  setActive(id: string, active: boolean) { const p = this.participants.get(id); if (p) p.active = active }
  kick(id: string) { this.participants.delete(id) }
  reset(_states: PersonaState[]) {}
  addParticipant(p: MockParticipant) { p.registry = this; this.participants.set(p.persona.id, p) }
  disposeAll() { this.participants.clear() }
}

class MockStore {
  private data = new Map<string, Conversation>()
  async init() {}
  async list(): Promise<ConversationMeta[]> {
    return [...this.data.values()].map((c) => ({
      id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messageCount: c.transcript.length,
    }))
  }
  async read(id: string): Promise<Conversation | null> { return this.data.get(id) ?? null }
  async write(conv: Conversation) { this.data.set(conv.id, conv) }
  async remove(id: string) { this.data.delete(id) }
}

function makePersona(id: string): Persona {
  return { id, name: id, color: "#000", icon: "🤖", tools: [], systemPrompt: "" }
}

describe("Room integration: handoff routing", () => {
  function setup() {
    const hub = new SseHub(1)
    const store = new MockStore()
    const registry = new MockRegistry()
    const room = new Room(registry as any, hub, store as any, [])
    const messages: Array<{ author: string; text: string }> = []
    const orig = hub.broadcast.bind(hub)
    hub.broadcast = (event, data, roomId?) => {
      if (event === "message") messages.push(data as { author: string; text: string })
      orig(event, data, roomId)
    }
    return { room, registry, messages }
  }

  test("a registered handoff chains to the target", async () => {
    const { room, registry, messages } = setup()
    const builder = new MockParticipant(makePersona("builder")).withResult({ text: "done", handoffTo: "auditor" })
    const auditor = new MockParticipant(makePersona("auditor")).withResult({ text: "looks good" })
    registry.addParticipant(builder)
    registry.addParticipant(auditor)
    await room.init()

    room.submit("@builder go")
    await new Promise((r) => setTimeout(r, 300))

    expect(messages.some((m) => m.author === "auditor" && m.text === "looks good")).toBe(true)
    await room.abortCurrent()
  })

  test("F5 regression: prose '@name' in an agent reply does NOT route", async () => {
    const { room, registry, messages } = setup()
    // No handoffTo set — the reply merely CONTAINS "@auditor" as prose, the
    // way an agent might narrate "the auditor dispatched @tester" or quote a
    // transcript. Before the handoff tool, resolveAgentMentions text-scanned
    // this and would have chained to auditor regardless of intent.
    const builder = new MockParticipant(makePersona("builder"))
      .withResult({ text: "Handed off to @auditor earlier — no further action needed here." })
    const auditor = new MockParticipant(makePersona("auditor")).withResult({ text: "should not run" })
    registry.addParticipant(builder)
    registry.addParticipant(auditor)
    await room.init()

    room.submit("@builder go")
    await new Promise((r) => setTimeout(r, 300))

    expect(messages.some((m) => m.author === "auditor")).toBe(false)
    expect(room.isBusy()).toBe(false) // turn ended, back to the human
    await room.abortCurrent()
  })

  test("no handoff called → turn ends, control returns to the human", async () => {
    const { room, registry } = setup()
    registry.addParticipant(new MockParticipant(makePersona("builder")).withResult({ text: "all done here" }))
    await room.init()

    room.submit("@builder go")
    await new Promise((r) => setTimeout(r, 200))

    expect(room.isBusy()).toBe(false)
  })
})
