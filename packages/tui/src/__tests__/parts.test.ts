import { describe, expect, test } from "vitest"
import type { ToolActivity, TurnPart } from "@pipeline-moe/client-core"
import { toSegments, windowSequence, SEQUENCE_WINDOW, MIN_FOLD } from "../parts.js"

// Block 3 of docs/interleaved-turns.md — the two reductions applied to a turn's
// chronological parts before anything is drawn. What is asserted here is
// exactly what a screenshot cannot check cheaply: that ORDER survives, and that
// windowing can never eat an error.

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
    // Six reads in a row with no thought between them are six lines of noise
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

describe("windowSequence", () => {
  const long = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "reasoning" as const, content: `s${i}` }))

  test("a short turn passes through untouched", () => {
    const segs = long(SEQUENCE_WINDOW)
    const w = windowSequence(segs)
    expect(w.head).toEqual(segs)
    expect(w.hidden).toBe(0)
    expect(w.tail).toEqual([])
  })

  test("folding fewer than MIN_FOLD segments is a net loss, so it does not happen", () => {
    // The marker costs a line and a collapsed segment IS a line. Observed live
    // on an 11-segment turn: three lines of chrome to save two.
    for (let extra = 1; extra < MIN_FOLD; extra++) {
      const segs = long(SEQUENCE_WINDOW + 1 + extra)
      const w = windowSequence(segs)
      expect(w.hidden).toBe(0)
      expect(w.head).toEqual(segs)
    }
    const folded = windowSequence(long(SEQUENCE_WINDOW + 1 + MIN_FOLD))
    expect(folded.hidden).toBe(MIN_FOLD)
  })

  test("a long turn keeps its first segment and its tail", () => {
    // How a turn STARTED is half of its shape, and it is the first thing a
    // tail-only window loses.
    const segs = long(20)
    const w = windowSequence(segs, 8)
    expect(w.head).toEqual([segs[0]])
    expect(w.tail).toEqual(segs.slice(-8))
    expect(w.hidden).toBe(11)
  })

  test("an error in the hidden middle is pinned, and not counted as hidden", () => {
    const segs: ReturnType<typeof toSegments> = [
      ...long(4),
      { kind: "tools", group: { toolName: "bash", items: [act("c1", "bash", "error")], status: "error" } },
      ...long(10),
    ]
    const w = windowSequence(segs, 8)
    expect(w.pinnedErrors).toHaveLength(1)
    expect(w.pinnedErrors[0]).toMatchObject({ kind: "tools", group: { status: "error" } })
    // 15 total, 1 head + 8 tail = 6 in the middle, of which 1 is the error.
    expect(w.hidden).toBe(5)
  })

  test("a successful tool group in the middle is not pinned", () => {
    const segs: ReturnType<typeof toSegments> = [
      ...long(4),
      { kind: "tools", group: { toolName: "read", items: [act("c1", "read")], status: "ok" } },
      ...long(10),
    ]
    expect(windowSequence(segs, 8).pinnedErrors).toEqual([])
  })
})
