// Fused seats — integration of the seat layer through the REAL Registry:
// persona → seat resolution, shared session dir, seat-level cursor,
// refcounted kick, defusion on mixed models, roster annotations.
// Sessions are real pi sessions (no LLM call is ever made — construction
// only), rooted in a temp dir.

import { mkdtemp, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent"
import { Registry } from "../registry.js"
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
