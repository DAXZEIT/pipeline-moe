import { describe, expect, test } from "vitest"
import type { ToolActivity, TurnPart } from "../types.js"
import { toSegments } from "../parts.js"

// docs/interleaved-turns.md — the reduction both clients apply to a turn's
// chronological parts before anything is drawn. What is asserted here is
// exactly what a screenshot cannot check cheaply: that ORDER survives, and
// that aggregation never invents adjacency.

const tool = (toolCallId: string): TurnPart => ({ type: "tool", toolCallId })
const say = (type: "reasoning" | "text", content: string): TurnPart => ({ type, content, ts: 0 })

const act = (toolCallId: string, toolName: string, status: ToolActivity["status"] = "ok"): ToolActivity => ({
  toolCallId,
  toolName,
  status,
  ts: 0,
})

/** Compact shape, for assertions about order. */
const shape = (segs: ReturnType<typeof toSegments>) =>
  segs.map((s) => (s.kind === "tools" ? `${s.group.toolName}×${s.group.items.length}` : s.kind[0])).join(" ")

describe("toSegments", () => {
  test("keeps the turn's order and resolves tool pointers", () => {
    const parts = [say("reasoning", "check it"), tool("c1"), say("reasoning", "again"), tool("c2"), say("text", "done")]
    const activity = [act("c1", "read"), act("c2", "grep")]
    expect(shape(toSegments(parts, activity))).toBe("r read×1 r grep×1 t")
  })

  test("consecutive same-tool ok calls still aggregate", () => {
    // Six reads in a row with no thought between them are six rows of noise
    // in an interleaved view; they are one ×6 group, exactly as before.
    const parts = [say("reasoning", "read them all"), tool("c1"), tool("c2"), tool("c3"), say("text", "ok")]
    const activity = [act("c1", "read"), act("c2", "read"), act("c3", "read")]
    expect(shape(toSegments(parts, activity))).toBe("r read×3 t")
  })

  test("an error never merges into a neighbouring group", () => {
    const parts = [tool("c1"), tool("c2"), tool("c3")]
    const activity = [act("c1", "read"), act("c2", "read", "error"), act("c3", "read")]
    expect(shape(toSegments(parts, activity))).toBe("read×1 read×1 read×1")
    expect(toSegments(parts, activity)[1]).toMatchObject({ kind: "tools", group: { status: "error" } })
  })

  test("aggregation never reaches across a thought", () => {
    // The whole point of the layout: two reads with a thought between them are
    // two moments, not one ×2 burst.
    const parts = [tool("c1"), say("reasoning", "hm"), tool("c2")]
    const activity = [act("c1", "read"), act("c2", "read")]
    expect(shape(toSegments(parts, activity))).toBe("read×1 r read×1")
  })

  test("an unresolved tool part is dropped, not drawn as a placeholder", () => {
    const parts = [say("text", "hi"), tool("missing")]
    expect(shape(toSegments(parts, []))).toBe("t")
  })

  test("empty segments are skipped — a live run is not trimmed at the source", () => {
    const parts = [say("reasoning", "  \n "), say("text", "real")]
    expect(shape(toSegments(parts, []))).toBe("t")
  })
})
