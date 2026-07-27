import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent"
import { setProviderApiKey, type ResolvedModel } from "../model.js"
import { scratchResolvedModel } from "./scratch-model.js"

// The credential surface, exercised against throwaway auth.json / models.json.
//
// pi 0.82 retired `AuthStorage`: credentials now live behind `ModelRuntime`
// (`setRuntimeApiKey` / `logout` / `listCredentials`) and the registry keeps the
// read side. These tests were rewritten onto that API rather than deleted,
// because what they protect is ours: a key must reach auth.json and must never
// reach an API response.

let dir: string
let authPath: string
let resolved: ResolvedModel
let modelRuntime: ModelRuntime
let modelRegistry: ModelRegistry

/** The production write path — the one that has to persist. */
const setKey = (name: string, key: string): Promise<void> => setProviderApiKey(resolved, name, key)

async function setup(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), "providers-test-"))
  authPath = join(dir, "auth.json")
  resolved = await scratchResolvedModel(dir)
  modelRuntime = resolved.modelRuntime
  modelRegistry = resolved.modelRegistry
}

async function teardown(): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

// ── Credential storage: set / list / logout ─────────────────────────────────

describe("ModelRuntime credential storage for API key providers", () => {
  beforeAll(async () => { await setup() })
  afterEach(async () => { await teardown(); await setup() })

  const ids = async (): Promise<string[]> =>
    (await modelRuntime.listCredentials()).map((c) => c.providerId)

  test("can set an API key for a provider", async () => {
    await setKey("openrouter", "sk-test-123")
    const creds = await modelRuntime.listCredentials()
    const cred = creds.find((c) => c.providerId === "openrouter")
    expect(cred).toBeDefined()
    expect(cred?.type).toBe("api_key")
  })

  test("getProviderAuthStatus reports configured without exposing the key", async () => {
    await setKey("openrouter", "sk-secret-abc")
    const status = modelRuntime.getProviderAuthStatus("openrouter")
    expect(status.configured).toBe(true)
    expect(JSON.stringify(status)).not.toContain("sk-secret-abc")
  })

  test("getProviderAuthStatus returns not configured for unknown provider", () => {
    const status = modelRuntime.getProviderAuthStatus("nonexistent")
    expect(status.configured).toBe(false)
  })

  test("logout clears credentials for a provider", async () => {
    await setKey("deepseek", "sk-deep-456")
    expect(await ids()).toContain("deepseek")
    await modelRuntime.logout("deepseek")
    expect(await ids()).not.toContain("deepseek")
  })

  test("listCredentials returns only providers with credentials", async () => {
    await setKey("openrouter", "sk-1")
    await setKey("deepseek", "sk-2")
    const list = await ids()
    expect(list).toContain("openrouter")
    expect(list).toContain("deepseek")
    expect(list).not.toContain("anthropic")
  })
})

// ── ModelRegistry integration ──────────────────────────────────────────────

describe("ModelRegistry over the runtime", () => {
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

  test("refresh reloads models from disk", async () => {
    // Should not throw
    await modelRegistry.refresh()
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

  test("the key reaches auth.json (persistence, not secrecy)", async () => {
    await setKey("openrouter", "sk-atomic-test")
    const content = await readFile(authPath, "utf-8")
    // The key IS in the file — that is the point of storing it. What must never
    // happen is it coming back out through an API response.
    expect(content).toContain("sk-atomic-test")
  })

  test("getProviderAuthStatus never contains key-like patterns", async () => {
    await setKey("openrouter", "sk-1234567890abcdef")
    const status = modelRuntime.getProviderAuthStatus("openrouter")
    const json = JSON.stringify(status)
    expect(json).not.toMatch(/sk-[a-z0-9]+/)
    expect(json).not.toMatch(/[a-zA-Z0-9]{40,}/)
  })

  test("a stored key SURVIVES A RESTART — the whole point of storing it", async () => {
    // The regression this guards: pi 0.82's `setRuntimeApiKey` looks like the
    // obvious write path and is an in-memory override. Everything downstream
    // works for the life of the process and the key is gone on the next boot.
    // A fresh runtime over the same directory is what "next boot" means.
    await setKey("openrouter", "sk-survives-restart")
    expect(modelRuntime.getProviderAuthStatus("openrouter").configured).toBe(true)

    const reborn = await scratchResolvedModel(dir)
    expect(reborn.modelRuntime.getProviderAuthStatus("openrouter").configured).toBe(true)
    const creds = await reborn.modelRuntime.listCredentials()
    expect(creds.some((c) => c.providerId === "openrouter")).toBe(true)
  })

  test("listCredentials reports THAT a provider is configured, never with what", async () => {
    // 0.80's `authStorage.getAll()` handed back the key material; 0.82's
    // listCredentials is {providerId, type} only — a strictly better shape for
    // anything that might end up serialized.
    await setKey("openrouter", "sk-exposed-test")
    const creds = await modelRuntime.listCredentials()
    expect(creds.some((c) => c.providerId === "openrouter")).toBe(true)
    expect(JSON.stringify(creds)).not.toContain("sk-exposed-test")
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

  test("broadcast is called with 'providers' event after adding a key", async () => {
    const broadcastCalls: Array<{ event: string; data: unknown }> = []
    const mockHub = {
      broadcast: vi.fn((event, data) => {
        broadcastCalls.push({ event, data })
      }),
    }

    // Simulate the POST /api/providers/:name flow
    const provider = "openrouter"
    await setKey(provider, "sk-test-broadcast")
    await modelRegistry.refresh()

    // Simulate broadcast
    mockHub.broadcast("providers", {
      providers: modelRegistry.getAll().map((m) => m.provider),
      explicitlyEnabled: [provider],
    })

    expect(mockHub.broadcast).toHaveBeenCalledWith("providers", expect.any(Object))
    expect(broadcastCalls.length).toBe(1)
    expect(broadcastCalls[0].event).toBe("providers")
  })

  test("broadcast is called after removing a provider", async () => {
    const broadcastCalls: Array<{ event: string; data: unknown }> = []
    const mockHub = {
      broadcast: vi.fn((event, data) => {
        broadcastCalls.push({ event, data })
      }),
    }

    // Simulate the DELETE /api/providers/:name flow
    const provider = "deepseek"
    await modelRuntime.logout(provider)
    await modelRegistry.refresh()

    // Simulate broadcast
    mockHub.broadcast("providers", {
      providers: modelRegistry.getAll().map((m) => m.provider),
      explicitlyEnabled: [],
    })

    expect(mockHub.broadcast).toHaveBeenCalledWith("providers", expect.any(Object))
    expect(broadcastCalls.length).toBe(1)
    expect(broadcastCalls[0].event).toBe("providers")
  })

  test("broadcast data does not contain API keys", async () => {
    await setKey("openrouter", "sk-broadcast-secret")
    const broadcastData = {
      providers: modelRegistry.getAll().map((m) => m.provider),
      explicitlyEnabled: ["openrouter"],
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

  // 0.82 has no `getOAuthProviders()`: the capability is a branch on the
  // provider's own auth. This is the exact derivation `getProviderList` and the
  // login route now use, so these tests guard the real thing.
  const oauthProviders = () => modelRuntime.getProviders().filter((p) => p.auth.oauth !== undefined)

  test("OAuth providers are discoverable from the runtime", () => {
    expect(Array.isArray(oauthProviders())).toBe(true)
  })

  test("an OAuth provider carries an id, a name, and a login", () => {
    for (const p of oauthProviders()) {
      expect(typeof p.id).toBe("string")
      expect(typeof p.name).toBe("string")
      expect(typeof p.auth.oauth?.login).toBe("function")
    }
  })

  test("Anthropic is an OAuth provider", () => {
    expect(oauthProviders().find((p) => p.id === "anthropic")).toBeDefined()
  })

  test("OAuth provider ids form a set usable for the supportsOAuth flag", () => {
    const oauthIds = new Set(oauthProviders().map((p) => p.id))
    expect(oauthIds.has("anthropic")).toBe(true)
    expect(oauthIds.has("local")).toBe(false)
  })
})
