// Fused seats — integration of the seat layer through the REAL Registry:
// persona → seat resolution, shared session dir, seat-level cursor,
// refcounted kick, defusion on mixed models, roster annotations.
// Sessions are real pi sessions (no LLM call is ever made — construction
// only), rooted in a temp dir.

import { mkdtemp, rm } from "node:fs/promises"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent"
import { Registry } from "../registry.js"
import { LONE_AGENT_NOTE, ROOM_NOTE } from "../seat-runtime.js"
import { SseHub } from "../sse.js"
import type { Persona } from "../types.js"

let dir: string
let registry: Registry

function persona(id: string, extra: Partial<Persona> = {}): Persona {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    color: "#123456",
    icon: "🧪",
    tools: ["read"],
    systemPrompt: `SHARED FOUNDATION\n${id} duties.`,
    ...extra,
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pmoe-seats-"))
  const authStorage = AuthStorage.create(join(dir, "auth.json"))
  const modelRegistry = ModelRegistry.create(authStorage, join(dir, "models.json"))
  registry = new Registry({ authStorage, modelRegistry, model: undefined }, new SseHub(1), new Set(), dir)
  registry.setSessionRoot(join(dir, "agents"))
})

afterEach(async () => {
  registry.disposeAll()
  await rm(dir, { recursive: true, force: true })
})

describe("fused seats through the real Registry", () => {
  test("two hats declaring the same seat share ONE session dir; a singleton keeps its own", async () => {
    const builder = await registry.create(persona("builder", { seat: "maker", tools: ["read", "edit", "write"] }))
    const tester = await registry.create(persona("tester", { seat: "maker", tools: ["read", "bash"] }))
    const auditor = await registry.create(persona("auditor"))

    expect(builder.sessionDir).toBe(tester.sessionDir)
    expect(builder.sessionDir).toContain("maker")
    expect(auditor.sessionDir).toContain("auditor")
    expect(builder.seat).toBe(tester.seat)
    expect(builder.seat.fused()).toBe(true)
    expect(auditor.seat.fused()).toBe(false)
  })

  test("the cursor is seat-level: one hat advancing it advances its seat-mate", async () => {
    const builder = await registry.create(persona("builder", { seat: "maker" }))
    const tester = await registry.create(persona("tester", { seat: "maker" }))
    builder.cursor = 42
    expect(tester.cursor).toBe(42)
  })

  test("kick is refcounted: the seat survives the first hat, dies with the last", async () => {
    const builder = await registry.create(persona("builder", { seat: "maker" }))
    await registry.create(persona("tester", { seat: "maker" }))
    const seatDir = builder.sessionDir!
    expect(existsSync(seatDir)).toBe(true)

    await registry.kick("builder")
    expect(registry.has("builder")).toBe(false)
    expect(registry.has("tester")).toBe(true)
    expect(existsSync(seatDir)).toBe(true) // tester still lives there

    await registry.kick("tester")
    expect(existsSync(seatDir)).toBe(false) // last hat gone → dir dropped
  })

  test("one-seat-one-modelRef: a mismatched newcomer defuses ITSELF into a singleton", async () => {
    await registry.create(persona("builder", { seat: "maker", model: "local/a.gguf" }))
    const tester = await registry.create(persona("tester", { seat: "maker", model: "local/b.gguf" }))
    expect(tester.seat.seatId).toBe("tester")
    expect(tester.seat.fused()).toBe(false)
    expect(registry.seatOf("builder")).toBe("maker")
  })

  test("batch load (reset) defuses a mixed-model seat WHOLE, loudly", async () => {
    const warnings: string[] = []
    registry.onSystemNote = (t) => warnings.push(t)
    await registry.reset([
      { ...persona("builder", { seat: "maker", model: "local/a.gguf" }), active: true },
      { ...persona("tester", { seat: "maker", model: "local/b.gguf" }), active: true },
    ])
    expect(registry.seatOf("builder")).toBe("builder")
    expect(registry.seatOf("tester")).toBe("tester")
    expect(warnings.some((w) => w.includes("mixes models"))).toBe(true)
  })

  test("roster items carry the seat only when fused; describeRoster annotates and marks every hat as you", async () => {
    await registry.create(persona("builder", { seat: "maker" }))
    await registry.create(persona("tester", { seat: "maker" }))
    await registry.create(persona("auditor"))

    const roster = registry.roster()
    expect(roster.find((r) => r.id === "builder")?.seat).toBe("maker")
    expect(roster.find((r) => r.id === "auditor")?.seat).toBeUndefined()

    const block = registry.describeRoster(["builder", "tester"])!
    expect(block).toContain("maker seat (shared context with @tester) ← you")
    expect(block).toContain("maker seat (shared context with @builder) ← you")
    expect(block).not.toContain("@auditor (Auditor) — room default model — read-only ← you")
  })

  test("reseat fuses two live singletons onto a fresh seat; old sessions are orphaned, not deleted", async () => {
    const builder = await registry.create(persona("builder"))
    const tester = await registry.create(persona("tester"))
    const oldBuilderDir = builder.sessionDir!
    expect(existsSync(oldBuilderDir)).toBe(true)

    const summary = await registry.reseat(["builder", "tester"], "maker")
    expect(summary).toContain("fresh shared context")
    const b = registry.get("builder")!
    const t = registry.get("tester")!
    expect(b.seat).toBe(t.seat)
    expect(b.seat.seatId).toBe("maker")
    expect(b.persona.seat).toBe("maker") // persisted birth mapping
    expect(existsSync(oldBuilderDir)).toBe(true) // orphaned, inspectable
    expect(registry.roster().find((r) => r.id === "builder")?.seat).toBe("maker")
  })

  test("reseat onto a LIVING seat joins its session (Q2 add-hat)", async () => {
    await registry.create(persona("builder", { seat: "maker" }))
    await registry.create(persona("tester", { seat: "maker" }))
    await registry.create(persona("scout"))
    const summary = await registry.reseat(["scout"], "maker")
    expect(summary).toContain("living context")
    expect(registry.get("scout")!.seat.seatId).toBe("maker")
    expect(registry.get("scout")!.seat.hatIds()).toEqual(["builder", "tester", "scout"])
  })

  test("reseat solo detaches a hat; the seat survives for the remaining hat", async () => {
    await registry.create(persona("builder", { seat: "maker" }))
    await registry.create(persona("tester", { seat: "maker" }))
    const summary = await registry.reseat(["tester"], "tester")
    expect(summary).toContain("detached")
    expect(registry.get("tester")!.seat.seatId).toBe("tester")
    expect(registry.get("tester")!.persona.seat).toBeUndefined()
    expect(registry.get("builder")!.seat.seatId).toBe("maker")
    expect(registry.get("builder")!.seat.fused()).toBe(false)
  })

  test("reseat refuses a model mix BEFORE mutating anything", async () => {
    await registry.create(persona("builder", { model: "local/a.gguf" }))
    await registry.create(persona("tester", { model: "local/b.gguf" }))
    await expect(registry.reseat(["builder", "tester"], "maker")).rejects.toThrow(/mix models/)
    expect(registry.get("builder")!.seat.seatId).toBe("builder") // untouched
    expect(registry.get("tester")!.seat.seatId).toBe("tester")
  })

  test("reseat onto a living seat reorders the mover next to its seat-mates (strip adjacency)", async () => {
    await registry.create(persona("scout"))
    await registry.create(persona("builder", { seat: "maker" }))
    await registry.create(persona("tester", { seat: "maker" }))
    await registry.reseat(["scout"], "maker")
    expect(registry.roster().map((r) => r.id)).toEqual(["builder", "tester", "scout"])
  })

  test("fusing scattered hats onto a fresh seat groups them at the first hat's slot", async () => {
    await registry.create(persona("scout"))
    await registry.create(persona("builder"))
    await registry.create(persona("auditor"))
    await registry.create(persona("tester"))
    await registry.reseat(["builder", "tester"], "maker")
    expect(registry.roster().map((r) => r.id)).toEqual(["scout", "builder", "tester", "auditor"])
  })

  test("reseat is a no-op with a friendly message when already seated", async () => {
    await registry.create(persona("auditor"))
    const summary = await registry.reseat(["auditor"], "auditor")
    expect(summary).toContain("already")
  })

  test("a fused seat session survives restart under the seat key (same store, different key)", async () => {
    const builder = await registry.create(persona("builder", { seat: "maker" }))
    const seatDir = builder.sessionDir!
    registry.disposeAll()

    const again = await registry.create(persona("builder", { seat: "maker" }))
    expect(again.sessionDir).toBe(seatDir)
  })
})

// Lone-agent framing — a room whose roster holds ONE active agent must not
// carry team scaffolding: no ROOM_NOTE ("shared multi-agent chat room"), no
// YOUR TEAM roster block, and (pre-existing gate in custom-tools) no handoff
// tool. The prompt and the toolset are built from the same predicate; the
// Registry rebuilds a seat when a roster mutation flips it.
describe("lone-agent framing (auto-degrade at roster==1)", () => {
  const prompt = (id: string) => registry.get(id)!.seat.session.systemPrompt
  const tools = (id: string) => registry.get(id)!.seat.session.getActiveToolNames()

  test("a lone singleton gets LONE_AGENT_NOTE — no ROOM_NOTE, no roster block, no handoff tool", async () => {
    await registry.create(persona("scout"))
    expect(prompt("scout")).toContain(LONE_AGENT_NOTE)
    expect(prompt("scout")).not.toContain(ROOM_NOTE)
    expect(prompt("scout")).not.toContain("YOUR TEAM")
    expect(tools("scout")).not.toContain("handoff")
  })

  test("gaining a teammate rebuilds the lone seat: team framing + handoff appear", async () => {
    await registry.create(persona("scout"))
    await registry.create(persona("builder"))
    for (const id of ["scout", "builder"]) {
      expect(prompt(id)).toContain(ROOM_NOTE)
      expect(prompt(id)).not.toContain(LONE_AGENT_NOTE)
      expect(prompt(id)).toContain("YOUR TEAM")
      expect(tools(id)).toContain("handoff")
    }
  })

  test("kicked back down to one, the survivor sheds the team framing", async () => {
    await registry.create(persona("scout"))
    await registry.create(persona("builder"))
    await registry.kick("builder")
    expect(prompt("scout")).toContain(LONE_AGENT_NOTE)
    expect(prompt("scout")).not.toContain("YOUR TEAM")
    expect(tools("scout")).not.toContain("handoff")
  })

  test("deactivating down to one reconciles too (async — the setActive path)", async () => {
    await registry.create(persona("scout"))
    await registry.create(persona("builder"))
    registry.setActive("builder", false)
    await vi.waitFor(() => {
      expect(prompt("scout")).toContain(LONE_AGENT_NOTE)
      expect(tools("scout")).not.toContain("handoff")
    })
    registry.setActive("builder", true)
    await vi.waitFor(() => {
      expect(prompt("scout")).toContain(ROOM_NOTE)
      expect(tools("scout")).toContain("handoff")
    })
  })

  test("a fused seat alone in the room KEEPS team framing — the hat switch is a real handoff", async () => {
    await registry.create(persona("builder", { seat: "maker" }))
    await registry.create(persona("tester", { seat: "maker" }))
    const seatPrompt = registry.get("builder")!.seat.session.systemPrompt
    expect(seatPrompt).toContain(ROOM_NOTE)
    expect(seatPrompt).not.toContain(LONE_AGENT_NOTE)
    expect(tools("builder")).toContain("handoff")
  })

  test("a 1-persona batch load (reset) builds lone directly", async () => {
    await registry.reset([{ ...persona("scout"), active: true }])
    expect(prompt("scout")).toContain(LONE_AGENT_NOTE)
    expect(tools("scout")).not.toContain("handoff")
  })

  test("a bare persona (empty systemPrompt) injects no persona layer", async () => {
    await registry.create(persona("pi", { systemPrompt: "" }))
    expect(prompt("pi")).toContain(LONE_AGENT_NOTE)
    // The persona layer contributed nothing: the working-directory note is the
    // first pipeline-owned part, straight after the base prompt.
    expect(prompt("pi")).toContain("Your working directory is")
    expect(prompt("pi")).not.toContain("YOUR TEAM")
  })
})

// The operator's personal ~/.pi/agent/SYSTEM.md is pi's own identity, written
// for the LOCAL brain. Only a bare solo persona resolving to a local model
// gets it; every other seat (team roles, cloud solo) runs on pi's STOCK
// prompt — team agents must not ride on the operator's persona, and a cloud
// solo must not be told it is a local agent on this machine's GPU.
describe("personal SYSTEM.md gating (pure pi = bare persona + local brain)", () => {
  const STOCK_MARKER = "coding assistant operating inside pi"
  const personalSystemMd = (): string | null => {
    const p = join(homedir(), ".pi", "agent", "SYSTEM.md")
    return existsSync(p) ? readFileSync(p, "utf-8") : null
  }
  /** A distinctive line of the operator's SYSTEM.md, to assert its absence. */
  const personalMarker = (): string | null => {
    const md = personalSystemMd()
    const line = md?.split("\n").find((l) => l.trim().length > 40)
    return line?.trim() ?? null
  }

  test("team personas run on the STOCK prompt, never the personal SYSTEM.md", async () => {
    await registry.create(persona("scout"))
    await registry.create(persona("builder"))
    const sp = registry.get("scout")!.seat.session.systemPrompt
    expect(sp).toContain(STOCK_MARKER)
    const marker = personalMarker()
    if (marker) expect(sp).not.toContain(marker)
  })

  test("a bare persona on a NON-local (or unresolved) model gets the stock prompt too", async () => {
    await registry.create(persona("pi", { systemPrompt: "" }))
    const sp = registry.get("pi")!.seat.session.systemPrompt
    expect(sp).toContain(STOCK_MARKER)
    const marker = personalMarker()
    if (marker) expect(sp).not.toContain(marker)
  })

  test("pure pi: a bare persona on a LOCAL brain gets the personal SYSTEM.md", async () => {
    const marker = personalMarker()
    if (!marker) return // machine without a personal pi identity — nothing to gate
    // A registry whose ModelRegistry actually KNOWS a local model, so the
    // persona's "local/…" ref resolves with provider "local".
    const dir2 = await mkdtemp(join(tmpdir(), "pmoe-purepi-"))
    writeFileSync(
      join(dir2, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: "http://localhost:9",
            api: "openai-completions",
            apiKey: "x",
            models: [
              {
                id: "test.gguf",
                name: "Test local",
                reasoning: false,
                input: ["text"],
                contextWindow: 1000,
                maxTokens: 100,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    )
    const authStorage = AuthStorage.create(join(dir2, "auth.json"))
    const modelRegistry = ModelRegistry.create(authStorage, join(dir2, "models.json"))
    const reg2 = new Registry({ authStorage, modelRegistry, model: undefined }, new SseHub(1), new Set(), dir2)
    reg2.setSessionRoot(join(dir2, "agents"))
    try {
      await reg2.create(persona("pi", { systemPrompt: "", model: "local/test.gguf" }))
      const sp = reg2.get("pi")!.seat.session.systemPrompt
      expect(sp).toContain(marker)
      expect(sp).not.toContain(STOCK_MARKER)
      expect(sp).toContain(LONE_AGENT_NOTE)
    } finally {
      reg2.disposeAll()
      await rm(dir2, { recursive: true, force: true })
    }
  })
})
