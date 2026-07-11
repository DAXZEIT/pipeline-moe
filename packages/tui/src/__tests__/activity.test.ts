import { describe, it, expect } from "vitest"
import type { ToolActivity } from "@pipeline-moe/client-core"
import { summarizeArgs, statusBadge, TOOL_ICON, groupActivity, windowActivity, groupLine, LIVE_WINDOW } from "../activity"

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

// ── groupActivity ────────────────────────────────────────────────────────────

const call = (toolName: string, status: ToolActivity["status"], id: string, args?: unknown): ToolActivity => ({
  toolCallId: id,
  toolName,
  status,
  args,
  ts: Date.now(),
})

describe("groupActivity", () => {
  it("merges consecutive same-tool ok calls into one ×N group", () => {
    const groups = groupActivity([call("read", "ok", "1"), call("read", "ok", "2"), call("read", "ok", "3")])
    expect(groups).toHaveLength(1)
    expect(groups[0].items).toHaveLength(3)
    expect(groups[0].status).toBe("ok")
  })

  it("does not merge across different tools", () => {
    const groups = groupActivity([call("read", "ok", "1"), call("edit", "ok", "2"), call("read", "ok", "3")])
    expect(groups.map((g) => g.toolName)).toEqual(["read", "edit", "read"])
  })

  it("never merges errors — each stays its own group", () => {
    const groups = groupActivity([call("bash", "error", "1"), call("bash", "error", "2"), call("bash", "ok", "3")])
    expect(groups).toHaveLength(3)
    expect(groups[0].status).toBe("error")
    expect(groups[1].status).toBe("error")
  })

  it("never merges the running call", () => {
    const groups = groupActivity([call("read", "ok", "1"), call("read", "running", "2")])
    expect(groups).toHaveLength(2)
    expect(groups[1].status).toBe("running")
  })

  it("an error breaks an ok run in two", () => {
    const groups = groupActivity([
      call("read", "ok", "1"),
      call("read", "error", "2"),
      call("read", "ok", "3"),
    ])
    expect(groups.map((g) => g.status)).toEqual(["ok", "error", "ok"])
  })
})

// ── windowActivity ───────────────────────────────────────────────────────────

describe("windowActivity", () => {
  it("shows everything when there are at most LIVE_WINDOW groups", () => {
    const groups = groupActivity([call("read", "ok", "1"), call("edit", "ok", "2")])
    const w = windowActivity(groups)
    expect(w.visible).toHaveLength(2)
    expect(w.pinnedErrors).toHaveLength(0)
    expect(w.hiddenCalls).toBe(0)
  })

  it("keeps only the last LIVE_WINDOW groups and counts hidden calls", () => {
    const acts = ["bash", "grep", "edit", "write", "ls"].map((t, i) => call(t, "ok", String(i)))
    const w = windowActivity(groupActivity(acts))
    expect(w.visible.map((g) => g.toolName)).toEqual(["edit", "write", "ls"])
    expect(w.hiddenCalls).toBe(2)
    expect(w.pinnedErrors).toHaveLength(0)
  })

  it("counts every call of a hidden ×N group", () => {
    const acts = [
      call("read", "ok", "1"),
      call("read", "ok", "2"),
      call("read", "ok", "3"),
      call("bash", "ok", "4"),
      call("edit", "ok", "5"),
      call("write", "ok", "6"),
    ]
    // groups: read×3, bash, edit, write → window keeps the last 3
    const w = windowActivity(groupActivity(acts))
    expect(w.hiddenCalls).toBe(3)
  })

  it("pins errors that scrolled past the window instead of hiding them", () => {
    const acts = [
      call("bash", "error", "1"),
      call("grep", "ok", "2"),
      call("edit", "ok", "3"),
      call("write", "ok", "4"),
      call("ls", "ok", "5"),
    ]
    const w = windowActivity(groupActivity(acts))
    expect(w.pinnedErrors).toHaveLength(1)
    expect(w.pinnedErrors[0].toolName).toBe("bash")
    // the pinned error is not counted as hidden
    expect(w.hiddenCalls).toBe(1)
  })

  it("an error inside the window is not pinned twice", () => {
    const acts = [call("bash", "ok", "1"), call("edit", "error", "2"), call("write", "running", "3")]
    const w = windowActivity(groupActivity(acts))
    expect(w.pinnedErrors).toHaveLength(0)
    expect(w.visible.map((g) => g.status)).toEqual(["ok", "error", "running"])
  })

  it("LIVE_WINDOW is 3", () => {
    expect(LIVE_WINDOW).toBe(3)
  })
})

// ── groupLine ────────────────────────────────────────────────────────────────

describe("groupLine", () => {
  it("single call keeps the classic format", () => {
    const g = groupActivity([call("read", "ok", "1", { file_path: "a.md" })])[0]
    const l = groupLine(g, 40)
    expect(l.text).toBe("  📖 read a.md  ok")
    expect(l.color).toBe("green")
  })

  it("×N group comma-joins its args", () => {
    const g = groupActivity([
      call("read", "ok", "1", { file_path: "a.md" }),
      call("read", "ok", "2", { file_path: "b.md" }),
    ])[0]
    const l = groupLine(g, 40)
    expect(l.text).toBe("  📖 read ×2 a.md, b.md  ok")
  })

  it("truncates the joined args to argWidth", () => {
    const g = groupActivity([
      call("read", "ok", "1", { file_path: "very/long/path/one.md" }),
      call("read", "ok", "2", { file_path: "very/long/path/two.md" }),
    ])[0]
    const l = groupLine(g, 12)
    expect(l.text).toContain("…")
    expect(l.text).toContain("×2")
  })

  it("error group renders red", () => {
    const g = groupActivity([call("bash", "error", "1", { command: "npm test" })])[0]
    const l = groupLine(g, 40)
    expect(l.color).toBe("red")
    expect(l.text).toContain("err")
  })
})
