// Repro: two-hop chain A→B→C in supervised mode. Tester reported the FIRST
// handoff bypassing the supervisor while the SECOND was supervised. This test
// counts how many times the supervisor runner is invoked and which pairs it saw.

import { describe, expect, test } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
import { ConversationStore } from "../store.js"
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
  async sendCustomMessage(m: { customType: string; content: string; display: boolean }) {
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
  supervisorRunner: (opts: { prompt: string; validTargetIds: string[] }) => Promise<SupervisorOutcome>
}

describe("supervised chain", () => {
  // Repro attempt for the live 'only last hop supervised' pattern: a 3-hop
  // chain with a DELAYED (async) supervisor runner, closer to live timing than
  // the immediate stub. Every hop must reach the supervisor.
  test("3-hop chain with a slow runner supervises EVERY hop", async () => {
    const registry = new MockRegistry()
    const room = new Room(registry as never, new SseHub(1), new MockStore() as never, [])
    await room.init()
    room.setRoutingMode("supervised")
    room.setFallbackAgent(null)
    // planner = supervisor; builder→scribe→auditor→scout (3 handoff hops).
    registry.add(new MockParticipant("planner", registry))
    registry.add(new MockParticipant("builder", registry, "scribe"))
    registry.add(new MockParticipant("scribe", registry, "auditor"))
    registry.add(new MockParticipant("auditor", registry, "scout"))
    registry.add(new MockParticipant("scout", registry))

    const seen: string[] = []
    priv(room).supervisorRunner = async (opts) => {
      const m = opts.prompt.match(/@\w+ → @\w+/g)
      if (m) seen.push(...m)
      await new Promise((r) => setTimeout(r, 40)) // slow, like a real model
      return { decision: { verdict: "accept", reason: "ok" } }
    }

    room.submit("@builder go")
    await sleep(1200)

    // If the live bug reproduces here, intermediate pairs are missing.
    expect(seen).toContain("@builder → @scribe")
    expect(seen).toContain("@scribe → @auditor")
    expect(seen).toContain("@auditor → @scout")
    expect(registry.get("scout")!.calls).toBe(1)
    await room.abortCurrent()
  })

  // ROOT CAUSE of the tester's live FAIL, reproduced deterministically.
  // When the USER @-mentions several agents, resolveTargets pre-loads them all
  // into the initial queue. proposeChain dedups a handoff against the queue
  // (`!target.includes(p)`), so a handoff to an ALREADY-QUEUED agent yields no
  // proposal — it never reaches superviseProposals and runs unsupervised. Only
  // a handoff to a not-yet-queued agent re-proposes and gets supervised, which
  // is why the tester saw ONLY the last hop of each chain supervised. This test
  // pins that behavior so any future change to it is a deliberate decision.
  test("multi-mention pre-queue BYPASSES supervision for pre-queued hops (documents live root cause)", async () => {
    const registry = new MockRegistry()
    const room = new Room(registry as never, new SseHub(1), new MockStore() as never, [])
    await room.init()
    room.setRoutingMode("supervised")
    room.setFallbackAgent(null)
    registry.add(new MockParticipant("planner", registry))
    registry.add(new MockParticipant("builder", registry, "scribe"))
    registry.add(new MockParticipant("scribe", registry, "auditor"))
    registry.add(new MockParticipant("auditor", registry))

    const seen: string[] = []
    priv(room).supervisorRunner = async (opts) => {
      const m = opts.prompt.match(/@\w+ → @\w+/g)
      if (m) seen.push(...m)
      return { decision: { verdict: "accept", reason: "ok" } }
    }

    // The tester's exact trigger: all three agents @-mentioned in one message.
    room.submit("@builder @scribe @auditor go")
    await sleep(600)

    // builder→scribe and scribe→auditor target already-queued agents → bypassed.
    expect(seen).not.toContain("@builder → @scribe")
    expect(seen).not.toContain("@scribe → @auditor")
    // But all three still ran (they were user-directed via the mentions).
    expect(registry.get("scribe")!.calls).toBe(1)
    expect(registry.get("auditor")!.calls).toBe(1)

    // Observability (design decision): each coalesced hop leaves a ≡ note so it
    // is never silent — authored by "system", not gated but visible.
    const coalesced = room.getTranscript().filter((e) => e.text.includes("≡"))
    expect(coalesced.map((e) => e.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("@builder → @scribe"),
        expect.stringContaining("@scribe → @auditor"),
      ]),
    )
    expect(coalesced.every((e) => e.author === "system")).toBe(true)
    expect(coalesced.every((e) => e.text.includes("coalesced"))).toBe(true)
    await room.abortCurrent()
  })

  test("coalescence note is supervised-only — auto mode stays quiet (no ≡ noise)", async () => {
    const registry = new MockRegistry()
    const room = new Room(registry as never, new SseHub(1), new MockStore() as never, [])
    await room.init()
    room.setRoutingMode("auto")
    room.setFallbackAgent(null)
    registry.add(new MockParticipant("planner", registry))
    registry.add(new MockParticipant("builder", registry, "scribe"))
    registry.add(new MockParticipant("scribe", registry, "auditor"))
    registry.add(new MockParticipant("auditor", registry))

    room.submit("@builder @scribe @auditor go")
    await sleep(600)

    // Auto mode has no supervisor — coalescing is the norm, no note to emit.
    expect(room.getTranscript().some((e) => e.text.includes("≡"))).toBe(false)
    expect(registry.get("auditor")!.calls).toBe(1)
    await room.abortCurrent()
  })

  test("BOTH handoffs in A→B→C are supervised", async () => {
    const registry = new MockRegistry()
    const store = new MockStore()
    const room = new Room(registry as never, new SseHub(1), store as never, [])
    await room.init()
    room.setRoutingMode("supervised")
    room.setFallbackAgent(null)
    // planner = supervisor; builder→scribe→scout chain.
    registry.add(new MockParticipant("planner", registry))
    registry.add(new MockParticipant("builder", registry, "scribe"))
    registry.add(new MockParticipant("scribe", registry, "scout"))
    registry.add(new MockParticipant("scout", registry))

    const seenPairs: string[] = []
    priv(room).supervisorRunner = async (opts) => {
      // The prompt embeds the "@from → @target" set; capture what the supervisor saw.
      const m = opts.prompt.match(/@\w+ → @\w+/g)
      if (m) seenPairs.push(...m)
      return { decision: { verdict: "accept", reason: "ok" } }
    }

    room.submit("@builder go")
    await sleep(600)

    // Both hops should have reached the supervisor.
    expect(registry.get("scribe")!.calls).toBe(1)
    expect(registry.get("scout")!.calls).toBe(1)
    expect(seenPairs).toContain("@builder → @scribe")
    expect(seenPairs).toContain("@scribe → @scout")

    // Live-verify FAIL repro: every accepted hop must leave a ✓ trace. The
    // tester saw accepted hops run silently — assert BOTH ✓ traces persist.
    const checks = room.getTranscript().filter((e) => e.text.includes("✓"))
    const pairs = checks.map((e) => e.text)
    expect(pairs.some((t) => t.includes("@builder → @scribe"))).toBe(true)
    expect(pairs.some((t) => t.includes("@scribe → @scout"))).toBe(true)
    await room.abortCurrent()
  })

  // The decisive check the planner asked for: not just posted in the live
  // transcript, but PERSISTED to the on-disk session JSON — the exact surface
  // the tester inspected. Uses a REAL ConversationStore on a real temp dir so
  // saveCurrent() writes actual files through the (now serialized) write path.
  test("BOTH ✓ traces are PERSISTED to the on-disk session JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pmoe-persist-"))
    try {
      const registry = new MockRegistry()
      const store = new ConversationStore(dir)
      await store.init()
      const room = new Room(registry as never, new SseHub(1), store as never, [])
      await room.init()
      room.setRoutingMode("supervised")
      room.setFallbackAgent(null)
      registry.add(new MockParticipant("planner", registry))
      registry.add(new MockParticipant("builder", registry, "scribe"))
      registry.add(new MockParticipant("scribe", registry, "scout"))
      registry.add(new MockParticipant("scout", registry))
      priv(room).supervisorRunner = async () => ({ decision: { verdict: "accept", reason: "ok" } })

      room.submit("@builder go")
      await sleep(600)
      await room.abortCurrent()

      // Read back from DISK (store.read → readFile), not the in-memory room.
      const metas = await store.list()
      expect(metas.length).toBe(1)
      const persisted = await store.read(metas[0].id)
      expect(persisted).not.toBeNull()
      const traceText = persisted!.transcript.map((e) => e.text).join("\n")
      // The exact failure the tester reported: accepted-hop ✓ traces missing on disk.
      expect(traceText).toContain("✓")
      expect(traceText).toMatch(/✓[^\n]*@builder → @scribe/)
      expect(traceText).toMatch(/✓[^\n]*@scribe → @scout/)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })
})
