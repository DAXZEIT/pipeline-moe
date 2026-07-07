import { describe, it, expect } from "vitest"
import type { ToolActivity } from "@pipeline-moe/client-core"
import { summarizeArgs, statusBadge, TOOL_ICON } from "../activity"

// ── helpers ──────────────────────────────────────────────────────────────────

const baseActivity = (partial: Partial<ToolActivity> = {}): ToolActivity => ({
  toolCallId: "tc-1",
  toolName: "bash",
  status: "running",
  ts: Date.now(),
  ...partial,
})

// ── summarizeArgs ────────────────────────────────────────────────────────────

describe("summarizeArgs", () => {
  it("extracts command key", () => {
    const a = baseActivity({ args: { command: "ls -la /tmp" } })
    expect(summarizeArgs(a)).toBe("ls -la /tmp")
  })

  it("extracts file_path key", () => {
    const a = baseActivity({ args: { file_path: "src/app.ts" } })
    expect(summarizeArgs(a)).toBe("src/app.ts")
  })

  it("extracts path key", () => {
    const a = baseActivity({ args: { path: "/home/dax" } })
    expect(summarizeArgs(a)).toBe("/home/dax")
  })

  it("extracts pattern key", () => {
    const a = baseActivity({ args: { pattern: "*.test.ts" } })
    expect(summarizeArgs(a)).toBe("*.test.ts")
  })

  it("prefers command over file_path (first match wins)", () => {
    const a = baseActivity({ args: { command: "echo hi", file_path: "test.txt" } })
    expect(summarizeArgs(a)).toBe("echo hi")
  })

  it("fallback: JSON.stringify when no recognized key exists", () => {
    const a = baseActivity({ args: { unknown: "value" } })
    expect(summarizeArgs(a)).toBe('{"unknown":"value"}')
  })

  it("returns empty string when args is undefined", () => {
    const a = baseActivity({ args: undefined })
    expect(summarizeArgs(a)).toBe("")
  })

  it("returns empty string when args is not an object", () => {
    const a = baseActivity({ args: "not-an-object" as unknown as ToolActivity["args"] })
    expect(summarizeArgs(a)).toBe("")
  })

  it("falls through to JSON.stringify for array-typed args", () => {
    const a = baseActivity({ args: ["arg1", "arg2"] as unknown as ToolActivity["args"] })
    expect(summarizeArgs(a)).toBe('["arg1","arg2"]')
  })
})

// ── statusBadge ──────────────────────────────────────────────────────────────

describe("statusBadge", () => {
  it("ok → green 'ok'", () => {
    expect(statusBadge("ok")).toEqual({ text: "ok", color: "green" })
  })

  it("error → red 'err'", () => {
    expect(statusBadge("error")).toEqual({ text: "err", color: "red" })
  })

  it("running → yellow '…'", () => {
    expect(statusBadge("running")).toEqual({ text: "…", color: "yellow" })
  })

  it("unknown status → yellow '…'", () => {
    expect(statusBadge("unknown")).toEqual({ text: "…", color: "yellow" })
  })
})

// ── TOOL_ICON ────────────────────────────────────────────────────────────────

describe("TOOL_ICON", () => {
  it("has icons for known tools", () => {
    expect(TOOL_ICON["bash"]).toBe("⌘")
    expect(TOOL_ICON["read"]).toBe("📖")
    expect(TOOL_ICON["write"]).toBe("✎")
    expect(TOOL_ICON["edit"]).toBe("✏️")
    expect(TOOL_ICON["grep"]).toBe("🔍")
    expect(TOOL_ICON["find"]).toBe("📁")
    expect(TOOL_ICON["ls"]).toBe("📂")
  })

  it("has 7 tool icons", () => {
    expect(Object.keys(TOOL_ICON).length).toBe(7)
  })
})
