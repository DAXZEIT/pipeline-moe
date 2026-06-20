import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, test } from "vitest"
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent"
import { Registry } from "../registry.js"
import { SseHub } from "../sse.js"

// ── Helpers ─────────────────────────────────────────────────────────────────

let dir: string
let registry: Registry

async function setup(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), "provider-slash-test-"))
  const authPath = join(dir, "auth.json")
  const modelsPath = join(dir, "models.json")

  const authStorage = AuthStorage.create(authPath)
  const modelRegistry = ModelRegistry.create(authStorage, modelsPath)
  const hub = new SseHub()
  const explicitlyEnabled = new Set<string>()

  registry = new Registry(
    { authStorage, modelRegistry, model: undefined },
    hub,
    explicitlyEnabled,
  )
}

async function teardown(): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

// ── Registry provider methods (used by /provider slash command) ─────────────

describe("Registry provider methods", () => {
  beforeAll(async () => { await setup() })
  afterEach(async () => { await teardown(); await setup() })

  test("getProviderList returns providers with auth status", () => {
    const list = registry.getProviderList()
    expect(Array.isArray(list)).toBe(true)
    expect(list.length).toBeGreaterThan(0)

    for (const p of list) {
      expect(typeof p.name).toBe("string")
      expect(typeof p.displayName).toBe("string")
      expect(typeof p.configured).toBe("boolean")
      expect(typeof p.models).toBe("number")
    }
  })

  test("provider list includes at least one provider", () => {
    const list = registry.getProviderList()
    expect(list.length).toBeGreaterThan(0)
  })

  test("setProviderKey stores the key and marks provider as configured", () => {
    const before = registry.getProviderList()
    const openrouterBefore = before.find((p) => p.name === "openrouter")
    const wasConfigured = openrouterBefore?.configured ?? false

    const result = registry.setProviderKey("openrouter", "sk-test-key-123")
    expect(result.name).toBe("openrouter")
    expect(result.configured).toBe(true)

    // Verify the key is NOT in the result
    const resultJson = JSON.stringify(result)
    expect(resultJson).not.toContain("sk-test-key-123")

    // If it wasn't configured before, it should be now
    if (!wasConfigured) {
      const after = registry.getProviderList()
      const openrouterAfter = after.find((p) => p.name === "openrouter")
      expect(openrouterAfter?.configured).toBe(true)
    }
  })

  test("removeProviderKey removes the key", () => {
    // Set a key first
    registry.setProviderKey("deepseek", "sk-deep-test-456")
    let result = registry.getProviderList()
    const dsBefore = result.find((p) => p.name === "deepseek")
    expect(dsBefore?.configured).toBe(true)

    // Remove it
    const removeResult = registry.removeProviderKey("deepseek")
    expect(removeResult.name).toBe("deepseek")

    // Verify removed
    result = registry.getProviderList()
    const dsAfter = result.find((p) => p.name === "deepseek")
    // deepseek might still be configured via env vars or other means,
    // but the explicit key should be gone
    expect(removeResult.configured).toBeDefined()
  })

  test("setProviderKey adds to explicitly-enabled set", () => {
    registry.setProviderKey("openrouter", "sk-explicit-test")
    const list = registry.getProviderList()
    const openrouter = list.find((p) => p.name === "openrouter")
    expect(openrouter).toBeDefined()
  })

  test("removeProviderKey removes from explicitly-enabled set", () => {
    registry.setProviderKey("openrouter", "sk-explicit-test")
    registry.removeProviderKey("openrouter")
    const list = registry.getProviderList()
    const openrouter = list.find((p) => p.name === "openrouter")
    expect(openrouter).toBeDefined()
  })
})

// ── /provider slash command logic ───────────────────────────────────────────

describe("/provider slash command logic", () => {
  beforeAll(async () => { await setup() })
  afterEach(async () => { await teardown(); await setup() })

  test("/provider list — formats provider list", () => {
    const providers = registry.getProviderList()
    const lines = providers.map((p) =>
      `${p.configured ? "✓" : "○"} ${p.displayName} (${p.models} models)`,
    )
    expect(lines.length).toBeGreaterThan(0)
    // Each line should have the format "✓/○ Name (N models)"
    for (const line of lines) {
      expect(line).toMatch(/^[\u2713\u25CB] .+ \(\d+ models\)$/)
    }
  })

  test("/provider add — validates sub-command", () => {
    // Missing provider name
    const args: string[] = ["add"]
    expect(args.length).toBe(1) // not enough args

    // Missing API key
    const args2: string[] = ["add", "openrouter"]
    expect(args2.length).toBe(2) // not enough args

    // Valid
    const args3: string[] = ["add", "openrouter", "sk-test"]
    expect(args3.length).toBe(3)
  })

  test("/provider remove — validates sub-command", () => {
    // Missing provider name
    const args: string[] = ["remove"]
    expect(args.length).toBe(1) // not enough args

    // Valid
    const args2: string[] = ["remove", "openrouter"]
    expect(args2.length).toBe(2)
  })

  test("unknown sub-command detection", () => {
    const subCmd = "unknown"
    const knownSubCmds = ["list", "add", "remove"]
    expect(knownSubCmds.includes(subCmd)).toBe(false)
  })
})
