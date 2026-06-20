import { describe, it, expect } from "vitest"
import {
  toolCallSignature,
  checkToolLoop,
  TOOL_REPEAT_THRESHOLD,
} from "../circuit-breaker.js"
import type { ToolActivity, TranscriptEntry } from "../types.js"

// ── Helper ──────────────────────────────────────────────────────────

function makeActivity(toolName: string, args?: Record<string, unknown>): ToolActivity {
  return { toolCallId: `tc-${Math.random()}`, toolName, args, status: "ok", ts: Date.now() }
}

function makeEntry(author: string, activity?: ToolActivity[]): TranscriptEntry {
  return {
    index: 0,
    author,
    authorName: author,
    text: "some output",
    ts: Date.now(),
    ...(activity ? { activity } : {}),
  }
}

// ── toolCallSignature ───────────────────────────────────────────────

describe("toolCallSignature", () => {
  it("fingerprints Edit with path + oldText", () => {
    const sig = toolCallSignature(makeActivity("Edit", { path: "/foo/bar.ts", oldText: "const x = 1", newText: "const x = 2" }))
    expect(sig).toBe("edit|/foo/bar.ts|const x = 1")
  })

  it("fingerprints Bash with command", () => {
    const sig = toolCallSignature(makeActivity("Bash", { command: "sed -n '63,100p' /home/dax/src/types.ts" }))
    expect(sig).toBe("bash|sed -n '63,100p' /home/dax/src/types.ts")
  })

  it("fingerprints Read with path", () => {
    const sig = toolCallSignature(makeActivity("Read", { path: "/foo/bar.ts" }))
    expect(sig).toBe("read|/foo/bar.ts")
  })

  it("fingerprints Write with path", () => {
    const sig = toolCallSignature(makeActivity("Write", { path: "/foo/bar.ts", content: "hello" }))
    expect(sig).toBe("write|/foo/bar.ts")
  })

  it("fingerprints Grep with path", () => {
    const sig = toolCallSignature(makeActivity("Grep", { path: "/src", pattern: "foo" }))
    expect(sig).toBe("grep|/src")
  })

  it("handles missing args gracefully", () => {
    const sig = toolCallSignature(makeActivity("bash"))
    expect(sig).toBe("bash")
  })

  it("falls back to JSON for unknown tools", () => {
    const sig = toolCallSignature(makeActivity("custom_tool", { key: "value" }))
    expect(sig).toContain("custom_tool|")
    expect(sig).toContain("value")
  })

  it("is case-insensitive on tool name", () => {
    const a = toolCallSignature(makeActivity("BASH", { command: "ls" }))
    const b = toolCallSignature(makeActivity("bash", { command: "ls" }))
    expect(a).toBe(b)
  })
})

// ── checkToolLoop ───────────────────────────────────────────────────

describe("checkToolLoop", () => {
  it("trips when the same tool call appears 3 times in one turn", () => {
    const tc = makeActivity("Bash", { command: "sed -n '63,100p' file.ts" })
    const activity = [tc, { ...tc, toolCallId: "t2" }, { ...tc, toolCallId: "t3" }]
    const result = checkToolLoop([], "builder", activity)
    expect(result.tripped).toBe(true)
    expect(result.count).toBe(TOOL_REPEAT_THRESHOLD)
  })

  it("does NOT trip with only 2 identical calls", () => {
    const tc = makeActivity("Bash", { command: "sed -n '63,100p' file.ts" })
    const activity = [tc, { ...tc, toolCallId: "t2" }]
    const result = checkToolLoop([], "builder", activity)
    expect(result.tripped).toBe(false)
  })

  it("trips across turns (1 in current + 2 in transcript)", () => {
    const tc = makeActivity("Edit", { path: "foo.ts", oldText: "old", newText: "new" })
    const transcript: TranscriptEntry[] = [
      makeEntry("builder", [tc]),
      makeEntry("builder", [{ ...tc, toolCallId: "t2" }]),
    ]
    const result = checkToolLoop(transcript, "builder", [{ ...tc, toolCallId: "t3" }])
    expect(result.tripped).toBe(true)
  })

  it("does NOT trip for different files", () => {
    const activity = [
      makeActivity("Edit", { path: "a.ts", oldText: "x", newText: "y" }),
      makeActivity("Edit", { path: "b.ts", oldText: "x", newText: "y" }),
      makeActivity("Edit", { path: "c.ts", oldText: "x", newText: "y" }),
    ]
    const result = checkToolLoop([], "builder", activity)
    expect(result.tripped).toBe(false)
  })

  it("does NOT trip for same tool with different args", () => {
    const activity = [
      makeActivity("Bash", { command: "ls" }),
      makeActivity("Bash", { command: "cat foo.ts" }),
      makeActivity("Bash", { command: "grep pattern file" }),
    ]
    const result = checkToolLoop([], "builder", activity)
    expect(result.tripped).toBe(false)
  })

  it("ignores entries from other authors", () => {
    const tc = makeActivity("Bash", { command: "sed -n '63,100p' file.ts" })
    const transcript: TranscriptEntry[] = [
      makeEntry("auditor", [tc]),
      makeEntry("auditor", [{ ...tc, toolCallId: "t2" }]),
    ]
    // Only 1 from current turn for "builder", auditor's calls don't count
    const result = checkToolLoop(transcript, "builder", [{ ...tc, toolCallId: "t3" }])
    expect(result.tripped).toBe(false)
  })

  it("handles entries with no activity gracefully", () => {
    const transcript: TranscriptEntry[] = [
      makeEntry("builder"),
      makeEntry("builder"),
    ]
    const tc = makeActivity("Read", { path: "foo.ts" })
    const result = checkToolLoop(transcript, "builder", [tc])
    expect(result.tripped).toBe(false)
  })

  it("trips at exactly the threshold with mixed tool calls", () => {
    const sed = makeActivity("Bash", { command: "sed -n '1,10p' file.ts" })
    const ls = makeActivity("Bash", { command: "ls" })
    // 2 seds + 1 ls in transcript, 1 sed in current = 3 seds total
    const transcript: TranscriptEntry[] = [
      makeEntry("builder", [sed, ls]),
      makeEntry("builder", [{ ...sed, toolCallId: "t2" }]),
    ]
    const result = checkToolLoop(transcript, "builder", [{ ...sed, toolCallId: "t3" }])
    expect(result.tripped).toBe(true)
    expect(result.signature).toContain("bash|sed")
  })
})
