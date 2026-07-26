import { beforeAll, describe, expect, test, vi } from "vitest"
import chalk from "chalk"
import { visibleWidth } from "@earendil-works/pi-tui"
import type { OAuthProgress } from "@pipeline-moe/client-core"
import { OAuthPanelComponent } from "../next/oauth.js"

// The OAuth panel. One component across the whole flow, reading the progress
// live, which is what lets a device code become a success message without the
// client tearing anything down.

beforeAll(() => {
  chalk.level = 3
})

const plain = (ls: string[]): string[] => ls.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
// Strip SGR *and* OSC 8 hyperlinks: a link's URL is not visible text.
const bare = (ls: string[]): string[] =>
  plain(ls).map((l) => l.replace(/\x1b\]8;;[^\x07\x1b]*(\x07|\x1b\\)/g, ""))
const vis = (s: string): number => visibleWidth(s)
const text = (ls: string[]): string => bare(ls).join("\n")

const ESC = "\x1b"
const ENTER = "\r"

function make(initial: OAuthProgress | null) {
  let progress = initial
  const onDismiss = vi.fn()
  const onSubmitInput = vi.fn()
  const c = new OAuthPanelComponent({ progress: () => progress, onDismiss, onSubmitInput })
  return { c, onDismiss, onSubmitInput, set: (p: OAuthProgress | null) => (progress = p) }
}

const device: OAuthProgress = {
  provider: "github",
  status: "device_code",
  verificationUri: "https://github.com/login/device",
  userCode: "WXYZ-1234",
}
const authUrl: OAuthProgress = {
  provider: "anthropic",
  status: "auth_url",
  url: "https://claude.ai/oauth/authorize?client_id=abc&state=xyz",
  instructions: "Approve in the browser, then paste the redirect URL.",
}

describe("OAuthPanelComponent", () => {
  test("a device flow shows the URL and the code the user has to type", () => {
    const { c } = make(device)
    const out = text(c.render(80))
    expect(out).toContain("OAuth · github")
    expect(out).toContain("github.com/login/device")
    expect(out).toContain("WXYZ-1234")
    expect(out).toContain("finish in your browser")
  })

  test("the URL is a real OSC 8 hyperlink, not just coloured text", () => {
    const { c } = make(device)
    expect(plain(c.render(80)).join("")).toContain("\x1b]8;;https://github.com/login/device")
  })

  test("an auth-URL flow offers an input line with the placeholder", () => {
    const { c } = make(authUrl)
    const out = text(c.render(80))
    expect(out).toContain("paste the redirect URL")
    expect(out).toContain("⏎ submit pasted URL")
  })

  test("typing and ⏎ submit the pasted value, then clear the field", () => {
    const { c, onSubmitInput } = make(authUrl)
    for (const ch of "https://x/cb?code=1") c.handleInput(ch)
    expect(text(c.render(80))).toContain("code=1")
    c.handleInput(ENTER)
    expect(onSubmitInput).toHaveBeenCalledWith("https://x/cb?code=1")
    expect(text(c.render(80))).toContain("paste the redirect URL")
  })

  test("a URL longer than the box survives whole — Ink showed only its last 59 chars", () => {
    const { c, onSubmitInput } = make(authUrl)
    const url = "https://claude.ai/callback?code=" + "z".repeat(200)
    for (const ch of url) c.handleInput(ch)
    // On screen it scrolls (pi-tui's Input owns that); what matters is that the
    // value the flow receives is the whole thing.
    c.handleInput(ENTER)
    expect(onSubmitInput).toHaveBeenCalledWith(url)
  })

  test("esc dismisses at any stage", () => {
    for (const p of [device, authUrl, { provider: "x", status: "progress" } as OAuthProgress]) {
      const { c, onDismiss } = make(p)
      c.handleInput(ESC)
      expect(onDismiss).toHaveBeenCalled()
    }
  })

  test("⏎ on a terminal state dismisses instead of submitting", () => {
    const { c, onDismiss, onSubmitInput } = make({ provider: "github", status: "success", message: "Authenticated." })
    expect(text(c.render(80))).toContain("esc / ⏎ dismiss")
    c.handleInput(ENTER)
    expect(onDismiss).toHaveBeenCalled()
    expect(onSubmitInput).not.toHaveBeenCalled()
  })

  test("keys are not swallowed into an invisible buffer while merely waiting", () => {
    const { c } = make({ provider: "x", status: "progress", message: "Waiting for authorization…" })
    for (const ch of "hello") c.handleInput(ch)
    expect(text(c.render(80))).toContain("Waiting for authorization…")
    expect(text(c.render(80))).not.toContain("hello")
  })

  test("the same component carries the flow from code to outcome", () => {
    const { c, set } = make(device)
    expect(text(c.render(80))).toContain("WXYZ-1234")
    set({ provider: "github", status: "progress", message: "Polling…" })
    expect(text(c.render(80))).toContain("Polling…")
    set({ provider: "github", status: "success", message: "Signed in." })
    const ok = text(c.render(80))
    expect(ok).toContain("✓ Signed in.")
    expect(ok).not.toContain("WXYZ-1234")
  })

  test("an error is red-framed and says why", () => {
    const { c } = make({ provider: "github", status: "error", message: "denied by user" })
    expect(text(c.render(80))).toContain("✗ denied by user")
  })

  test("no progress at all renders nothing", () => {
    const { c } = make(null)
    expect(c.render(80)).toEqual([])
  })

  test("every framed line is exactly the width, URLs included", () => {
    for (const p of [device, authUrl]) {
      for (const w of [40, 56, 80, 120]) {
        const { c } = make(p)
        for (const line of c.render(w)) expect(vis(line)).toBe(w)
      }
    }
  })
})
