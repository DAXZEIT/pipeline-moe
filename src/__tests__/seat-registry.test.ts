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

  test("a fused seat session survives restart under the seat key (same store, different key)", async () => {
    const builder = await registry.create(persona("builder", { seat: "maker" }))
    const seatDir = builder.sessionDir!
    registry.disposeAll()

    const again = await registry.create(persona("builder", { seat: "maker" }))
    expect(again.sessionDir).toBe(seatDir)
  })
})
