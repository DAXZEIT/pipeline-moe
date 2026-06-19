import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { config } from "../config.js"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
import type { Persona, PersonaState } from "../types.js"

// ── Mocks ────────────────────────────────────────────────────────────────

class MockParticipant {
  persona: Persona
  active = true
  parallel = false
  status: "idle" | "active" | "thinking" | "working" = "idle"
  cursor = 0
  isCompacting = false

  private _stats: unknown = undefined
  private _ctxUsage: unknown = undefined
  private _availableLevels: string[] | undefined = undefined
  private _compactResult: { summary: string; tokensBefore: number } | null = null
  private _compactError: string | null = null

  constructor(persona: Persona) {
    this.persona = persona
  }

  withStats(stats: {
    userMessages: number
    assistantMessages: number
    toolCalls: number
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  }) {
    this._stats = stats
    return this
  }

  withContextUsage(usage: { tokens: number | null; contextWindow: number; percent: number | null }) {
    this._ctxUsage = usage
    return this
  }

  withAvailableLevels(levels: string[]) {
    this._availableLevels = levels
    return this
  }

  withCompactResult(result: { summary: string; tokensBefore: number }) {
    this._compactResult = result
    return this
  }

  withCompactFailure(error: string) {
    this._compactError = error
    return this
  }

  getSessionStats() {
    return this._stats
  }

  getContextUsage() {
    return this._ctxUsage
  }

  getAvailableThinkingLevels() {
    return this._availableLevels
  }

  async compact(): Promise<{ summary: string; tokensBefore: number }> {
    if (this._compactError) throw new Error(this._compactError)
    if (this._compactResult) return this._compactResult
    throw new Error("no compact result configured")
  }

  async setThinkingLevel(_level: string) {
    return this
  }

  async abort() {}
  dispose() {}
}

class MockRegistry {
  private participants = new Map<string, MockParticipant>()

  private _allowedModels: string[] = ["local/qwen3.6-27b", "local/qwopus3.6-27b"]

  constructor(allowedModels?: string[]) {
    if (allowedModels) this._allowedModels = allowedModels
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
  setActive(_id: string, _active: boolean) {}
  kick(id: string) { this.participants.delete(id) }

  async update(id: string, _patch: { model?: string }): Promise<MockParticipant> {
    const p = this.participants.get(id)
    if (!p) throw new Error(`unknown participant "${id}"`)
    return p
  }

  async setThinkingLevel(id: string, _level: string): Promise<MockParticipant> {
    const p = this.participants.get(id)
    if (!p) throw new Error(`unknown participant "${id}"`)
    return p
  }

  isAllowedModel(ref: string): boolean {
    return this._allowedModels.includes(ref)
  }

  addParticipant(p: MockParticipant) {
    this.participants.set(p.persona.id, p)
  }

  personaStates(): PersonaState[] {
    return [...this.participants.values()].map((p) => ({
      ...p.persona,
      active: p.active,
      parallel: p.parallel,
    }))
  }

  activeParticipants(): MockParticipant[] {
    return [...this.participants.values()].filter((p) => p.active)
  }

  reset(_states: PersonaState[]) {}
  disposeAll() { this.participants.clear() }
}

class MockStore {
  async init() {}
  async list() { return [] }
  async read(_id: string) { return null }
  async write(_conv: any) {}
  async remove(_id: string) {}
}

interface NoticeEvent { msg: string; level: string }

class EventCapture {
  notices: NoticeEvent[] = []

  constructor(private hub: SseHub) {
    const orig = hub.broadcast.bind(hub)
    hub.broadcast = (event, data) => {
      if (event === "notice") {
        this.notices.push(data as NoticeEvent)
      }
      orig(event, data)
    }
  }
}

function makePersona(id: string): Persona {
  return { id, name: id, color: "#000", icon: "🤖", tools: [], systemPrompt: "" }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("slash commands", () => {
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
    await room.abortCurrent()
    events.notices = []
  })

  describe("/help", () => {
    test("lists all commands", async () => {
      room.submit("/help")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.msg.includes("/help"))
      expect(notice).toBeDefined()
      expect(notice!.msg).toContain("/kick")
      expect(notice!.msg).toContain("/model")
      expect(notice!.msg).toContain("/thinking")
      expect(notice!.msg).toContain("/stats")
      expect(notice!.msg).toContain("/chaining")
      expect(notice!.msg).toContain("/default")
    })
  })

  describe("/model", () => {
    test("changes model for an agent", async () => {
      const agent = new MockParticipant(makePersona("builder"))
      registry.addParticipant(agent)

      room.submit("/model @builder local/qwen3.6-27b")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.msg.includes("model →"))
      expect(notice).toBeDefined()
      expect(notice!.msg).toContain("local/qwen3.6-27b")
    })

    test("errors on missing args", async () => {
      room.submit("/model")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.level === "error")
      expect(notice).toBeDefined()
      expect(notice!.msg).toContain("usage")
    })

    test("errors on unknown agent", async () => {
      room.submit("/model @ghost local/qwen3.6-27b")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.msg.includes("unknown"))
      expect(notice).toBeDefined()
      expect(notice!.level).toBe("error")
    })

    test("errors on disallowed model", async () => {
      const agent = new MockParticipant(makePersona("builder"))
      registry.addParticipant(agent)

      room.submit("/model @builder cloud/gpt-5")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.msg.includes("not available"))
      expect(notice).toBeDefined()
      expect(notice!.level).toBe("error")
    })
  })

  describe("/thinking", () => {
    test("sets global thinking level", async () => {
      room.submit("/thinking high")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.msg.includes("Global thinking"))
      expect(notice).toBeDefined()
      expect(notice!.msg).toContain("high")
      expect(config.thinkingLevel).toBe("high")
    })

    test("sets per-agent thinking level", async () => {
      const agent = new MockParticipant(makePersona("builder"))
      registry.addParticipant(agent)

      room.submit("/thinking @builder xhigh")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.msg.includes("thinking →"))
      expect(notice).toBeDefined()
      expect(notice!.msg).toContain("@builder")
      expect(notice!.msg).toContain("xhigh")
    })

    test("errors on invalid level", async () => {
      room.submit("/thinking extreme")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.level === "error")
      expect(notice).toBeDefined()
    })

    test("errors on unknown agent for per-agent", async () => {
      room.submit("/thinking @ghost high")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.msg.includes("unknown"))
      expect(notice).toBeDefined()
      expect(notice!.level).toBe("error")
    })

    test("errors when level not in agent's available levels", async () => {
      const agent = new MockParticipant(makePersona("builder"))
      agent.withAvailableLevels(["off", "minimal", "low"])
      registry.addParticipant(agent)

      room.submit("/thinking @builder xhigh")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.msg.includes("not available"))
      expect(notice).toBeDefined()
      expect(notice!.level).toBe("error")
    })

    test("skips available-level check when agent has no available levels", async () => {
      const agent = new MockParticipant(makePersona("builder"))
      // No withAvailableLevels called → getAvailableThinkingLevels returns undefined
      registry.addParticipant(agent)

      room.submit("/thinking @builder xhigh")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.msg.includes("thinking →"))
      expect(notice).toBeDefined()
    })
  })

  describe("/stats", () => {
    test("shows per-agent stats", async () => {
      const agent = new MockParticipant(makePersona("builder"))
      agent.withStats({
        userMessages: 5,
        assistantMessages: 4,
        toolCalls: 3,
        tokens: { input: 42000, output: 8000, cacheRead: 38000, cacheWrite: 2000, total: 50000 },
      })
      agent.withContextUsage({ tokens: 55000, contextWindow: 128000, percent: 43 })
      registry.addParticipant(agent)

      room.submit("/stats @builder")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.msg.includes("@builder"))
      expect(notice).toBeDefined()
      expect(notice!.msg).toContain("42000i")
      expect(notice!.msg).toContain("8000o")
      expect(notice!.msg).toContain("cache 76%")
      expect(notice!.msg).toContain("3 tools")
      expect(notice!.msg).toContain("9 msgs")
      expect(notice!.msg).toContain("43%")
    })

    test("shows all agents summary", async () => {
      const agent1 = new MockParticipant(makePersona("builder"))
      agent1.withStats({
        userMessages: 5,
        assistantMessages: 4,
        toolCalls: 3,
        tokens: { input: 42000, output: 8000, cacheRead: 38000, cacheWrite: 2000, total: 50000 },
      })
      const agent2 = new MockParticipant(makePersona("auditor"))
      registry.addParticipant(agent1)
      registry.addParticipant(agent2)

      room.submit("/stats")
      await new Promise((r) => setTimeout(r, 100))

      const builderNotice = events.notices.find((n) => n.msg.includes("@builder"))
      const auditorNotice = events.notices.find((n) => n.msg.includes("@auditor"))
      expect(builderNotice).toBeDefined()
      expect(auditorNotice).toBeDefined()
      expect(builderNotice!.msg).toContain("42000i")
      expect(auditorNotice!.msg).toContain("no stats yet")
    })

    test("errors on unknown agent", async () => {
      room.submit("/stats @ghost")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.msg.includes("unknown"))
      expect(notice).toBeDefined()
      expect(notice!.level).toBe("error")
    })
  })

  describe("/chaining", () => {
    test("turns chaining on", async () => {
      room.setChaining(false)
      room.submit("/chaining on")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.msg.includes("Chaining → on"))
      expect(notice).toBeDefined()
      expect(room.getChaining()).toBe(true)
    })

    test("turns chaining off", async () => {
      room.setChaining(true)
      room.submit("/chaining off")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.msg.includes("Chaining → off"))
      expect(notice).toBeDefined()
      expect(room.getChaining()).toBe(false)
    })

    test("errors on invalid value", async () => {
      room.submit("/chaining maybe")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.level === "error")
      expect(notice).toBeDefined()
    })
  })

  describe("/default", () => {
    test("sets default agent", async () => {
      const agent = new MockParticipant(makePersona("builder"))
      registry.addParticipant(agent)

      room.submit("/default @builder")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.msg.includes("Default agent"))
      expect(notice).toBeDefined()
      expect(notice!.msg).toContain("@builder")
    })

    test("sets default agent without @", async () => {
      const agent = new MockParticipant(makePersona("builder"))
      registry.addParticipant(agent)

      room.submit("/default builder")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.msg.includes("Default agent"))
      expect(notice).toBeDefined()
      expect(notice!.msg).toContain("@builder")
    })

    test("clears default agent with 'none'", async () => {
      room.submit("/default none")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.msg.includes("none"))
      expect(notice).toBeDefined()
    })

    test("errors on unknown agent", async () => {
      room.submit("/default @ghost")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.level === "error")
      expect(notice).toBeDefined()
    })
  })

  describe("unknown command", () => {
    test("shows error for unknown command", async () => {
      room.submit("/foobar")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.msg.includes("Unknown command"))
      expect(notice).toBeDefined()
      expect(notice!.level).toBe("error")
    })
  })

  describe("existing commands still work", () => {
    test("/kick still works with new parser", async () => {
      const agent = new MockParticipant(makePersona("builder"))
      registry.addParticipant(agent)

      room.submit("/kick @builder")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.msg.includes("Kicked"))
      expect(notice).toBeDefined()
      expect(registry.has("builder")).toBe(false)
    })

    test("/activate still works with new parser", async () => {
      room.submit("/activate @builder")
      await new Promise((r) => setTimeout(r, 100))

      // Should show "unknown participant" since builder not in registry
      const notice = events.notices.find((n) => n.level === "error")
      expect(notice).toBeDefined()
    })

    test("/deactivate still works with new parser", async () => {
      room.submit("/deactivate @builder")
      await new Promise((r) => setTimeout(r, 100))

      const notice = events.notices.find((n) => n.level === "error")
      expect(notice).toBeDefined()
    })
  })
})
