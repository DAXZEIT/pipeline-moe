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

function nCopies(tc: ToolActivity, n: number): ToolActivity[] {
  return Array.from({ length: n }, (_, i) => ({ ...tc, toolCallId: `t${i}` }))
}

// ── toolCallSignature ───────────────────────────────────────────────

describe("toolCallSignature", () => {
  it("fingerprints Edit with path + oldText", () => {
    const sig = toolCallSignature(makeActivity("Edit", { path: "/foo/bar.ts", oldText: "const x = 1", newText: "const x = 2" }))
    expect(sig).toBe("edit|/foo/bar.ts|const x = 1")
  })

  it("fingerprints Bash with command", () => {
    const sig = toolCallSignature(makeActivity("Bash", { command: "sed -n '63,100p' /home/user/src/types.ts" }))
    expect(sig).toBe("bash|sed -n '63,100p' /home/user/src/types.ts")
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
  it("trips when 7 consecutive identical calls in one turn", () => {
    const tc = makeActivity("Bash", { command: "sed -n '63,100p' file.ts" })
    const result = checkToolLoop([], "builder", nCopies(tc, 7))
    expect(result.tripped).toBe(true)
    expect(result.count).toBe(TOOL_REPEAT_THRESHOLD)
  })

  it("does NOT trip with only 6 identical calls", () => {
    const tc = makeActivity("Bash", { command: "sed -n '63,100p' file.ts" })
    const result = checkToolLoop([], "builder", nCopies(tc, 6))
    expect(result.tripped).toBe(false)
  })

  it("does NOT trip with only 2 identical calls", () => {
    const tc = makeActivity("Bash", { command: "sed -n '63,100p' file.ts" })
    const result = checkToolLoop([], "builder", nCopies(tc, 2))
    expect(result.tripped).toBe(false)
  })

  it("trips across turns — consecutive same-author entries", () => {
    const tc = makeActivity("Edit", { path: "foo.ts", oldText: "old", newText: "new" })
    const transcript: TranscriptEntry[] = [
      makeEntry("builder", [tc]),
      makeEntry("builder", [tc]),
      makeEntry("builder", [tc]),
      makeEntry("builder", [tc]),
      makeEntry("builder", [tc]),
      makeEntry("builder", [tc]),
    ]
    // 6 in transcript + 1 in current = 7 consecutive
    const result = checkToolLoop(transcript, "builder", [tc])
    expect(result.tripped).toBe(true)
  })

  it("does NOT trip — 6 consecutive + 1 different + 6 consecutive resets", () => {
    const tc = makeActivity("Bash", { command: "sed file.ts" })
    const different = makeActivity("Read", { path: "other.ts" })
    // 6 seds + 1 read + 6 seds = max consecutive run of 6
    const activity = [...nCopies(tc, 6), different, ...nCopies(tc, 6)]
    const result = checkToolLoop([], "builder", activity)
    expect(result.tripped).toBe(false)
  })

  it("does NOT trip — interleaved different calls reset the counter", () => {
    const tc = makeActivity("Bash", { command: "sed file.ts" })
    const different = makeActivity("Read", { path: "other.ts" })
    // sed, read, sed, read, sed, read, sed, read = max run of 1
    const activity: ToolActivity[] = []
    for (let i = 0; i < 10; i++) {
      activity.push(i % 2 === 0 ? { ...tc, toolCallId: `t${i}` } : { ...different, toolCallId: `d${i}` })
    }
    const result = checkToolLoop([], "builder", activity)
    expect(result.tripped).toBe(false)
  })

  it("trips — consecutive run across turn boundaries", () => {
    const tc = makeActivity("Bash", { command: "sed file.ts" })
    // 4 in transcript + 3 in current = 7 consecutive
    const transcript: TranscriptEntry[] = [
      makeEntry("builder", [tc]),
      makeEntry("builder", [tc]),
      makeEntry("builder", [tc]),
      makeEntry("builder", [tc]),
    ]
    const result = checkToolLoop(transcript, "builder", nCopies(tc, 3))
    expect(result.tripped).toBe(true)
  })

  it("does NOT trip — non-consecutive scattered calls even if total >= 7", () => {
    const tc = makeActivity("Bash", { command: "sed file.ts" })
    const different = makeActivity("Read", { path: "other.ts" })
    // 3 seds + read + 3 seds + read + 1 sed = total 7 but max consecutive = 3
    const transcript: TranscriptEntry[] = [
      makeEntry("builder", [tc]),
      makeEntry("builder", [tc]),
      makeEntry("builder", [tc]),
      makeEntry("builder", [different]),
      makeEntry("builder", [tc]),
      makeEntry("builder", [tc]),
      makeEntry("builder", [tc]),
      makeEntry("builder", [different]),
    ]
    const result = checkToolLoop(transcript, "builder", [tc])
    expect(result.tripped).toBe(false)
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
      makeEntry("auditor", [tc]),
      makeEntry("auditor", [tc]),
    ]
    // Only 1 from current turn for "builder", auditor's calls don't count
    const result = checkToolLoop(transcript, "builder", [tc])
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

  it("trips at threshold with mixed calls — consecutive seds at end", () => {
    const sed = makeActivity("Bash", { command: "sed -n '1,10p' file.ts" })
    const ls = makeActivity("Bash", { command: "ls" })
    // ls + 6 seds + 1 sed in current = 7 consecutive seds
    const transcript: TranscriptEntry[] = [
      makeEntry("builder", [ls]),
      makeEntry("builder", [sed]),
      makeEntry("builder", [sed]),
      makeEntry("builder", [sed]),
      makeEntry("builder", [sed]),
      makeEntry("builder", [sed]),
      makeEntry("builder", [sed]),
    ]
    const result = checkToolLoop(transcript, "builder", [sed])
    expect(result.tripped).toBe(true)
    expect(result.signature).toContain("bash|sed")
  })

  it("TOOL_REPEAT_THRESHOLD is 7", () => {
    expect(TOOL_REPEAT_THRESHOLD).toBe(7)
  })

  it("LOOKBACK_WINDOW uses most recent entries, not oldest", () => {
    const tc = makeActivity("Bash", { command: "sed file.ts" })
    const different = makeActivity("Read", { path: "other.ts" })
    // Old entries (beyond LOOKBACK_WINDOW): 7+ consecutive seds
    // Recent entries (within LOOKBACK_WINDOW): different calls — no consecutive run >= 7
    // The breaker should look at RECENT entries, so the 7 seds in old entries don't trip
    const transcript: TranscriptEntry[] = [
      // Old entries — 7 consecutive seds (beyond LOOKBACK_WINDOW)
      makeEntry("builder", [tc]),
      makeEntry("builder", [tc]),
      makeEntry("builder", [tc]),
      makeEntry("builder", [tc]),
      makeEntry("builder", [tc]),
      makeEntry("builder", [tc]),
      makeEntry("builder", [tc]),
      // Recent entries — different calls (within LOOKBACK_WINDOW)
      makeEntry("builder", [different]),
      makeEntry("builder", [different]),
      makeEntry("builder", [different]),
      makeEntry("builder", [different]),
      makeEntry("builder", [different]),
      makeEntry("builder", [different]),
    ]
    // Current turn: just one sed — max consecutive from recent = 1
    const result = checkToolLoop(transcript, "builder", [tc])
    expect(result.tripped).toBe(false)
  })
})
