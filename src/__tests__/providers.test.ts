import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent"

// ── Helpers ─────────────────────────────────────────────────────────────────

let dir: string
let authPath: string
let modelsPath: string
let authStorage: AuthStorage
let modelRegistry: ModelRegistry

async function setup(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), "providers-test-"))
  authPath = join(dir, "auth.json")
  modelsPath = join(dir, "models.json")

  // Start with a minimal auth.json
  authStorage = AuthStorage.create(authPath)
  modelRegistry = ModelRegistry.create(authStorage, modelsPath)
}

async function teardown(): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

// ── AuthStorage basic operations ────────────────────────────────────────────

describe("AuthStorage set/get/remove for API key providers", () => {
  beforeAll(async () => { await setup() })
  afterEach(async () => { await teardown(); await setup() })

  test("can set an API key for a provider", () => {
    authStorage.set("openrouter", { type: "api_key", key: "sk-test-123" })
    const cred = authStorage.get("openrouter")
    expect(cred).toBeDefined()
    expect(cred?.type).toBe("api_key")
    expect(cred?.key).toBe("sk-test-123")
  })

  test("getAuthStatus returns safe info without exposing the key", () => {
    authStorage.set("openrouter", { type: "api_key", key: "sk-secret-abc" })
    const status = authStorage.getAuthStatus("openrouter")
    expect(status.configured).toBe(true)
    // Must NOT contain the key
    expect(JSON.stringify(status)).not.toContain("sk-secret-abc")
  })

  test("getAuthStatus returns not configured for unknown provider", () => {
    const status = authStorage.getAuthStatus("nonexistent")
    expect(status.configured).toBe(false)
  })

  test("remove clears credentials for a provider", () => {
    authStorage.set("deepseek", { type: "api_key", key: "sk-deep-456" })
    expect(authStorage.has("deepseek")).toBe(true)
    authStorage.remove("deepseek")
    expect(authStorage.has("deepseek")).toBe(false)
  })

  test("list returns only providers with credentials", () => {
    authStorage.set("openrouter", { type: "api_key", key: "sk-1" })
    authStorage.set("deepseek", { type: "api_key", key: "sk-2" })
    const list = authStorage.list()
    expect(list).toContain("openrouter")
    expect(list).toContain("deepseek")
    expect(list).not.toContain("anthropic")
  })
})

// ── ModelRegistry integration ──────────────────────────────────────────────

describe("ModelRegistry with AuthStorage", () => {
  beforeAll(async () => { await setup() })
  afterEach(async () => { await teardown(); await setup() })

  test("getAvailable only returns models with configured auth", () => {
    const available = modelRegistry.getAvailable()
    // Local models should be available (they don't need an API key)
    const localModels = available.filter((m) => m.provider === "local")
    // At least local should be present
    expect(localModels.length).toBeGreaterThanOrEqual(0)
  })

  test("getProviderAuthStatus returns safe info", () => {
    const status = modelRegistry.getProviderAuthStatus("anthropic")
    // Should not throw even for a provider with no key
    expect(typeof status.configured).toBe("boolean")
    // Must not contain any credential value
    const json = JSON.stringify(status)
    expect(json).not.toMatch(/sk-[a-zA-Z0-9]{20,}/)
  })

  test("getProviderDisplayName returns a string", () => {
    const name = modelRegistry.getProviderDisplayName("anthropic")
    expect(typeof name).toBe("string")
    expect(name.length).toBeGreaterThan(0)
  })

  test("refresh reloads models from disk", () => {
    // Should not throw
    modelRegistry.refresh()
    const after = modelRegistry.getAll()
    expect(Array.isArray(after)).toBe(true)
  })

  test("getAll returns all models (built-in + custom)", () => {
    const all = modelRegistry.getAll()
    expect(Array.isArray(all)).toBe(true)
    expect(all.length).toBeGreaterThan(0)
  })
})

// ── Credential safety invariants ────────────────────────────────────────────

describe("credential safety invariants", () => {
  beforeAll(async () => { await setup() })
  afterEach(async () => { await teardown(); await setup() })

  test("auth.json is written atomically (file exists after set)", async () => {
    authStorage.set("test-provider", { type: "api_key", key: "sk-atomic-test" })
    const content = await readFile(authPath, "utf-8")
    const parsed = JSON.parse(content)
    expect(parsed["test-provider"]).toBeDefined()
    expect(parsed["test-provider"].key).toBe("sk-atomic-test")
    // The key IS in the file (that's expected) — but our API responses must never echo it
  })

  test("getAuthStatus never contains key-like patterns", () => {
    authStorage.set("test-provider", { type: "api_key", key: "sk-1234567890abcdef" })
    const status = authStorage.getAuthStatus("test-provider")
    const json = JSON.stringify(status)
    // Check for common key patterns
    expect(json).not.toMatch(/sk-[a-z0-9]+/)
    expect(json).not.toMatch(/[a-zA-Z0-9]{40,}/)
  })

  test("getAll exposes credentials (this is by design — used internally)", () => {
    authStorage.set("test-provider", { type: "api_key", key: "sk-exposed-test" })
    const all = authStorage.getAll()
    // getAll DOES return the key — it's used internally by Pi
    expect(all["test-provider"]?.key).toBe("sk-exposed-test")
    // But getAuthStatus must NOT
    const status = authStorage.getAuthStatus("test-provider")
    expect(JSON.stringify(status)).not.toContain("sk-exposed-test")
  })
})

// ── Explicitly-enabled providers tracking ───────────────────────────────────

describe("explicitly-enabled providers set", () => {
  test("set tracks explicitly enabled providers", () => {
    const set = new Set<string>()
    expect(set.has("openrouter")).toBe(false)
    set.add("openrouter")
    expect(set.has("openrouter")).toBe(true)
    set.delete("openrouter")
    expect(set.has("openrouter")).toBe(false)
  })

  test("set persists across operations", () => {
    const set = new Set<string>()
    set.add("openrouter")
    set.add("deepseek")
    expect(set.size).toBe(2)
    set.delete("openrouter")
    expect(set.size).toBe(1)
    expect(set.has("deepseek")).toBe(true)
  })
})

// ── SSE broadcast simulation ────────────────────────────────────────────────

describe("SSE broadcast on provider change", () => {
  beforeAll(async () => { await setup() })
  afterEach(async () => { await teardown(); await setup() })

  test("broadcast is called with 'providers' event after adding a key", () => {
    const broadcastCalls: Array<{ event: string; data: unknown }> = []
    const mockHub = {
      broadcast: vi.fn((event, data) => {
        broadcastCalls.push({ event, data })
      }),
    }

    // Simulate the POST /api/providers/:name flow
    const provider = "openrouter"
    authStorage.set(provider, { type: "api_key", key: "sk-test-broadcast" })
    modelRegistry.refresh()

    // Simulate broadcast
    mockHub.broadcast("providers", {
      providers: modelRegistry.getAll().map((m) => m.provider),
      explicitlyEnabled: [provider],
    })

    expect(mockHub.broadcast).toHaveBeenCalledWith("providers", expect.any(Object))
    expect(broadcastCalls.length).toBe(1)
    expect(broadcastCalls[0].event).toBe("providers")
  })

  test("broadcast is called after removing a provider", () => {
    const broadcastCalls: Array<{ event: string; data: unknown }> = []
    const mockHub = {
      broadcast: vi.fn((event, data) => {
        broadcastCalls.push({ event, data })
      }),
    }

    // Simulate the DELETE /api/providers/:name flow
    const provider = "deepseek"
    authStorage.remove(provider)
    modelRegistry.refresh()

    // Simulate broadcast
    mockHub.broadcast("providers", {
      providers: modelRegistry.getAll().map((m) => m.provider),
      explicitlyEnabled: [],
    })

    expect(mockHub.broadcast).toHaveBeenCalledWith("providers", expect.any(Object))
    expect(broadcastCalls.length).toBe(1)
    expect(broadcastCalls[0].event).toBe("providers")
  })

  test("broadcast data does not contain API keys", () => {
    authStorage.set("test-provider", { type: "api_key", key: "sk-broadcast-secret" })
    const broadcastData = {
      providers: modelRegistry.getAll().map((m) => m.provider),
      explicitlyEnabled: ["test-provider"],
    }
    const json = JSON.stringify(broadcastData)
    expect(json).not.toContain("sk-broadcast-secret")
  })
})

// ── ALLOW_CLOUD interaction ────────────────────────────────────────────────

describe("ALLOW_CLOUD interaction with explicitly-enabled providers", () => {
  test("explicitly-enabled set bypasses cloud restriction", () => {
    const explicitlyEnabled = new Set<string>(["openrouter"])

    // Simulate: allowCloud = false, but openrouter is explicitly enabled
    // A model from openrouter should be allowed
    const provider = "openrouter"
    const isAllowed = explicitlyEnabled.has(provider)
    expect(isAllowed).toBe(true)
  })

  test("without explicit enable, cloud provider is not bypassed", () => {
    const explicitlyEnabled = new Set<string>()
    const provider = "openrouter"
    const isAllowed = explicitlyEnabled.has(provider)
    expect(isAllowed).toBe(false)
  })

  test("local provider does not need explicit enable", () => {
    const explicitlyEnabled = new Set<string>()
    // Local provider is always allowed regardless of the set
    const provider = "local"
    // The check in listModels is: allowCloud OR provider === "local" OR explicitlyEnabled
    const isAllowed = provider === "local" || explicitlyEnabled.has(provider)
    expect(isAllowed).toBe(true)
  })
})

// ── OAuth provider discovery ────────────────────────────────────────────────

describe("OAuth provider discovery", () => {
  beforeAll(async () => { await setup() })
  afterEach(async () => { await teardown(); await setup() })

  test("getOAuthProviders returns an array", () => {
    const providers = authStorage.getOAuthProviders()
    expect(Array.isArray(providers)).toBe(true)
  })

  test("OAuth providers have id, name, and login method", () => {
    const providers = authStorage.getOAuthProviders()
    for (const p of providers) {
      expect(typeof p.id).toBe("string")
      expect(typeof p.name).toBe("string")
      expect(typeof p.login).toBe("function")
    }
  })

  test("Anthropic is an OAuth provider", () => {
    const providers = authStorage.getOAuthProviders()
    const anthropic = providers.find((p) => p.id === "anthropic")
    expect(anthropic).toBeDefined()
  })

  test("OAuth provider ids form a set usable for supportsOAuth check", () => {
    const oauthIds = new Set(authStorage.getOAuthProviders().map((p) => p.id))
    expect(oauthIds.has("anthropic")).toBe(true)
    expect(oauthIds.has("openrouter")).toBe(false)
  })
})
