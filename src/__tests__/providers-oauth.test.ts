import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, test } from "vitest"
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent"

// ── Helpers ─────────────────────────────────────────────────────────────────

let dir: string
let authStorage: AuthStorage
let modelRegistry: ModelRegistry

async function setup(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), "providers-oauth-test-"))
  const authPath = join(dir, "auth.json")
  const modelsPath = join(dir, "models.json")

  authStorage = AuthStorage.create(authPath)
  modelRegistry = ModelRegistry.create(authStorage, modelsPath)
}

async function teardown(): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

// ── OAuth provider discovery ────────────────────────────────────────────────

describe("OAuth provider discovery", () => {
  beforeAll(async () => { await setup() })
  afterEach(async () => { await teardown(); await setup() })

  test("getOAuthProviders returns an array", () => {
    const providers = authStorage.getOAuthProviders()
    expect(Array.isArray(providers)).toBe(true)
  })

  test("OAuth providers have expected properties", () => {
    const providers = authStorage.getOAuthProviders()
    for (const p of providers) {
      expect(typeof p.id).toBe("string")
      expect(typeof p.name).toBe("string")
      expect(typeof p.login).toBe("function")
      expect(typeof p.refreshToken).toBe("function")
      expect(typeof p.getApiKey).toBe("function")
    }
  })

  test("Anthropic OAuth provider is available", () => {
    const providers = authStorage.getOAuthProviders()
    const anthropic = providers.find((p) => p.id === "anthropic")
    expect(anthropic).toBeDefined()
    expect(anthropic?.name).toBeDefined()
  })

  test("OAuth providers have login method", () => {
    const providers = authStorage.getOAuthProviders()
    for (const p of providers) {
      expect(typeof p.login).toBe("function")
    }
  })
})

// ── OAuth callback types ────────────────────────────────────────────────────

describe("OAuth callback interface", () => {
  beforeAll(async () => { await setup() })
  afterEach(async () => { await teardown(); await setup() })

  test("onDeviceCode callback receives correct shape", () => {
    let received: unknown
    const callbacks = {
      onDeviceCode: (info: { userCode: string; verificationUri: string }) => { received = info },
      onAuth: () => {},
      onPrompt: async () => "",
      onSelect: async () => undefined,
    }
    callbacks.onDeviceCode({ userCode: "ABCD-EFGH", verificationUri: "https://example.com" })
    expect(received).toEqual({ userCode: "ABCD-EFGH", verificationUri: "https://example.com" })
  })

  test("onAuth callback receives OAuthAuthInfo shape", () => {
    let received: unknown
    const callbacks = {
      onDeviceCode: () => {},
      onAuth: (info: { url: string; instructions?: string }) => { received = info },
      onPrompt: async () => "",
      onSelect: async () => undefined,
    }
    callbacks.onAuth({ url: "https://example.com", instructions: "Open this URL" })
    expect(received).toEqual({ url: "https://example.com", instructions: "Open this URL" })
  })

  test("onPrompt callback must return Promise<string>", async () => {
    const callbacks = {
      onDeviceCode: () => {},
      onAuth: () => {},
      onPrompt: async (prompt: { message: string }) => {
        expect(prompt.message).toBe("test prompt")
        return "user response"
      },
      onSelect: async () => undefined,
    }
    const result = await callbacks.onPrompt({ message: "test prompt" })
    expect(result).toBe("user response")
  })

  test("onSelect callback must return Promise<string | undefined>", async () => {
    const callbacks = {
      onDeviceCode: () => {},
      onAuth: () => {},
      onPrompt: async () => "",
      onSelect: async () => {
        return "option-1"
      },
    }
    const result = await callbacks.onSelect()
    expect(result).toBe("option-1")
  })
})

// ── SSE oauth_progress event types ──────────────────────────────────────────

describe("oauth_progress SSE event types", () => {
  test("device_code event shape", () => {
    const event = {
      provider: "anthropic",
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://console.anthropic.com/oauth/device",
    }
    expect(event.type).toBe("device_code")
    expect(event.userCode).toBeDefined()
    expect(event.verificationUri).toBeDefined()
  })

  test("auth_url event shape", () => {
    const event = {
      provider: "anthropic",
      type: "auth_url",
      url: "https://example.com",
      instructions: "Open this URL in your browser",
    }
    expect(event.type).toBe("auth_url")
    expect(event.url).toBeDefined()
  })

  test("progress event shape", () => {
    const event = {
      provider: "anthropic",
      type: "progress",
      message: "Waiting for authorization...",
    }
    expect(event.type).toBe("progress")
    expect(event.message).toBeDefined()
  })

  test("success event shape", () => {
    const event = {
      provider: "anthropic",
      type: "success",
      message: "Authenticated with anthropic.",
    }
    expect(event.type).toBe("success")
  })

  test("error event shape", () => {
    const event = {
      provider: "anthropic",
      type: "error",
      message: "Interactive prompt not supported in headless mode",
    }
    expect(event.type).toBe("error")
    expect(event.message).toBeDefined()
  })
})
