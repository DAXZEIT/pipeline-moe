import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, test } from "vitest"
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent"
import { listModels, isAllowedModel } from "../model.js"
import type { ResolvedModel } from "../model.js"

// ── Helpers ─────────────────────────────────────────────────────────────────

let dir: string
let resolved: ResolvedModel

async function setup(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), "provider-models-test-"))
  const authPath = join(dir, "auth.json")
  const modelsPath = join(dir, "models.json")

  const authStorage = AuthStorage.create(authPath)
  const modelRegistry = ModelRegistry.create(authStorage, modelsPath)

  resolved = { authStorage, modelRegistry, model: undefined }
}

async function teardown(): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

// ── listModels basic behavior ───────────────────────────────────────────────

describe("listModels basic behavior", () => {
  beforeAll(async () => { await setup() })
  afterEach(async () => { await teardown(); await setup() })

  test("returns an array of ModelInfo objects", () => {
    const models = listModels(resolved, false)
    expect(Array.isArray(models)).toBe(true)
    // May be empty if no providers have auth configured in the test env
    // (getAvailable() only returns models with configured credentials)
  })

  test("each model has the expected shape", () => {
    const models = listModels(resolved, false)
    for (const m of models) {
      expect(m.provider).toBeDefined()
      expect(m.id).toBeDefined()
      expect(m.ref).toBe(`${m.provider}/${m.id}`)
      expect(m.name).toBeDefined()
      expect(typeof m.local).toBe("boolean")
    }
  })

  test("local provider models are marked local: true", () => {
    const models = listModels(resolved, false)
    const localModels = models.filter((m) => m.local)
    for (const m of localModels) {
      expect(m.provider).toBe("local")
    }
  })

  test("listModels returns models from getAvailable", () => {
    const models = listModels(resolved, false)
    const available = resolved.modelRegistry.getAvailable()
    // listModels is a view over getAvailable — length should be <= available
    expect(models.length).toBeLessThanOrEqual(available.length)
  })

  test("all returned models have correct shape", () => {
    const models = listModels(resolved, false)
    for (const m of models) {
      expect(typeof m.provider).toBe("string")
      expect(typeof m.id).toBe("string")
      expect(m.ref).toBe(`${m.provider}/${m.id}`)
      expect(typeof m.name).toBe("string")
      expect(typeof m.local).toBe("boolean")
      expect(m.local).toBe(m.provider === "local")
    }
  })
})

// ── isAllowedModel basic behavior ───────────────────────────────────────────

describe("isAllowedModel basic behavior", () => {
  beforeAll(async () => { await setup() })
  afterEach(async () => { await teardown(); await setup() })

  test("returns true for a model that exists in listModels", () => {
    const models = listModels(resolved, false)
    if (models.length > 0) {
      const allowed = isAllowedModel(resolved, false, models[0].ref)
      expect(allowed).toBe(true)
    }
  })

  test("returns false for a non-existent model ref", () => {
    const allowed = isAllowedModel(resolved, false, "nonexistent/fake-model-123")
    expect(allowed).toBe(false)
  })

  test("returns false for an empty ref", () => {
    const allowed = isAllowedModel(resolved, false, "")
    expect(allowed).toBe(false)
  })
})

// ── Explicitly-enabled providers set behavior ───────────────────────────────

describe("explicitly-enabled providers set mechanics", () => {
  beforeAll(async () => { await setup() })
  afterEach(async () => { await teardown(); await setup() })

  test("empty set means no extra providers", () => {
    const explicit = new Set<string>()
    expect(explicit.has("anthropic")).toBe(false)
    expect(explicit.has("openrouter")).toBe(false)
  })

  test("adding a provider makes it available", () => {
    const explicit = new Set<string>()
    explicit.add("anthropic")
    expect(explicit.has("anthropic")).toBe(true)
    expect(explicit.has("openrouter")).toBe(false)
  })

  test("removing a provider makes it unavailable again", () => {
    const explicit = new Set<string>()
    explicit.add("anthropic")
    expect(explicit.has("anthropic")).toBe(true)
    explicit.delete("anthropic")
    expect(explicit.has("anthropic")).toBe(false)
  })

  test("multiple providers can be tracked", () => {
    const explicit = new Set<string>()
    explicit.add("anthropic")
    explicit.add("openrouter")
    explicit.add("deepseek")
    expect(explicit.size).toBe(3)
    expect(explicit.has("anthropic")).toBe(true)
    expect(explicit.has("openrouter")).toBe(true)
    expect(explicit.has("deepseek")).toBe(true)
    expect(explicit.has("local")).toBe(false)
  })

  test("listModels accepts the explicitly-enabled set", () => {
    const explicit = new Set<string>(["anthropic"])
    // Should not throw
    const models = listModels(resolved, false, explicit)
    expect(Array.isArray(models)).toBe(true)
  })

  test("isAllowedModel accepts the explicitly-enabled set", () => {
    const explicit = new Set<string>(["anthropic"])
    // Should not throw
    const models = listModels(resolved, false, explicit)
    if (models.length > 0) {
      const allowed = isAllowedModel(resolved, false, models[0].ref, explicit)
      expect(typeof allowed).toBe("boolean")
    }
  })
})

// ── Provider auth status safety ─────────────────────────────────────────────

describe("provider auth status safety", () => {
  beforeAll(async () => { await setup() })
  afterEach(async () => { await teardown(); await setup() })

  test("getProviderAuthStatus never exposes key material", () => {
    resolved.authStorage.set("test-provider", { type: "api_key", key: "sk-super-secret-key-12345" })
    const status = resolved.modelRegistry.getProviderAuthStatus("test-provider")
    const json = JSON.stringify(status)
    expect(json).not.toContain("sk-super-secret")
    expect(json).not.toContain("12345")
    expect(typeof status.configured).toBe("boolean")
  })

  test("getProviderAuthStatus works for unknown providers", () => {
    const status = resolved.modelRegistry.getProviderAuthStatus("totally-unknown-provider")
    expect(typeof status.configured).toBe("boolean")
  })

  test("getProviderDisplayName returns a non-empty string", () => {
    const name = resolved.modelRegistry.getProviderDisplayName("anthropic")
    expect(typeof name).toBe("string")
    expect(name.length).toBeGreaterThan(0)
  })
})
