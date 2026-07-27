import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, test } from "vitest"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { oauthProgressPayload } from "../oauth-events.js"
import { scratchResolvedModel } from "./scratch-model.js"

// The OAuth surface, minus the flow itself — starting a real one means talking
// to an external provider, so what is testable here is (1) which providers can
// do OAuth at all and (2) the translation from pi's login events to the
// `oauth_progress` payloads clients read.
//
// pi 0.82 removed `authStorage.getOAuthProviders()`: the capability is now a
// branch on the provider's own auth (`Provider.auth.oauth`). Both the provider
// list and the login route derive it that way, so these tests derive it the same
// way — a test that recomputed it differently would agree with itself and
// nothing else.

let dir: string
let modelRuntime: ModelRuntime

async function setup(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), "providers-oauth-test-"))
  modelRuntime = (await scratchResolvedModel(dir)).modelRuntime
}

async function teardown(): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

describe("OAuth provider discovery", () => {
  beforeAll(async () => { await setup() })
  afterEach(async () => { await teardown(); await setup() })

  const oauthProviders = () => modelRuntime.getProviders().filter((p) => p.auth.oauth !== undefined)

  test("the runtime exposes OAuth-capable providers", () => {
    expect(oauthProviders().length).toBeGreaterThan(0)
  })

  test("each carries an id, a name, and the three OAuth operations", () => {
    for (const p of oauthProviders()) {
      expect(typeof p.id).toBe("string")
      expect(typeof p.name).toBe("string")
      expect(typeof p.auth.oauth?.login).toBe("function")
      expect(typeof p.auth.oauth?.refresh).toBe("function")
      expect(typeof p.auth.oauth?.toAuth).toBe("function")
    }
  })

  test("Anthropic is OAuth-capable; the local server is not", () => {
    // OpenRouter used to be the negative case here. In 0.82 it grew an OAuth
    // branch of its own, so the honest negative is a provider that could never
    // have one: the llama-server this stack talks to.
    const ids = new Set(oauthProviders().map((p) => p.id))
    expect(ids.has("anthropic")).toBe(true)
    expect(ids.has("local")).toBe(false)
  })

  test("an api-key-only provider is reachable but not OAuth-capable", () => {
    // qwen-token-plan is the case that motivated the 0.82 bump: a subscription
    // provider that authenticates with a key, so the /providers key path serves
    // it and the login route must refuse it.
    const qwen = modelRuntime.getProvider("qwen-token-plan")
    expect(qwen).toBeDefined()
    expect(qwen?.auth.oauth).toBeUndefined()
    expect(qwen?.auth.apiKey).toBeDefined()
  })
})

describe("login events → oauth_progress payloads", () => {
  test("a device code carries the code and the verification URI", () => {
    expect(
      oauthProgressPayload("anthropic", {
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://console.anthropic.com/oauth/device",
        intervalSeconds: 5,
      }),
    ).toEqual({
      provider: "anthropic",
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://console.anthropic.com/oauth/device",
    })
  })

  test("an auth URL keeps its instructions — the panel renders both", () => {
    expect(
      oauthProgressPayload("anthropic", {
        type: "auth_url",
        url: "https://example.com/authorize",
        instructions: "Open this URL in your browser",
      }),
    ).toEqual({
      provider: "anthropic",
      type: "auth_url",
      url: "https://example.com/authorize",
      instructions: "Open this URL in your browser",
    })
  })

  test("progress passes through", () => {
    expect(oauthProgressPayload("anthropic", { type: "progress", message: "Waiting…" })).toEqual({
      provider: "anthropic",
      type: "progress",
      message: "Waiting…",
    })
  })

  test("0.82's new `info` event lands on progress rather than being dropped", () => {
    expect(
      oauthProgressPayload("anthropic", {
        type: "info",
        message: "Approve the request in your browser",
        links: [{ url: "https://example.com", label: "console" }],
      }),
    ).toEqual({
      provider: "anthropic",
      type: "progress",
      message: "Approve the request in your browser",
    })
  })

  test("no payload ever carries a field the client cannot read", () => {
    const kinds = ["device_code", "auth_url", "progress", "info"] as const
    for (const type of kinds) {
      const event =
        type === "device_code"
          ? ({ type, userCode: "X", verificationUri: "u" } as const)
          : type === "auth_url"
            ? ({ type, url: "u" } as const)
            : ({ type, message: "m" } as const)
      const payload = oauthProgressPayload("p", event)
      expect(["device_code", "auth_url", "progress"]).toContain(payload.type)
      expect(payload.provider).toBe("p")
    }
  })
})
