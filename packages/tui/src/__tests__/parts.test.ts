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
  // The reduction itself now lives in client-core (the web renderer needs the
  // same segments), and its behaviour is pinned by client-core's parts.test.
  // What is still worth asserting here: the TUI reaches the shared version, so
  // a broken re-export fails loudly instead of silently drawing nothing.
  test("re-exported from client-core, order intact", () => {
    const parts = [say("reasoning", "check it"), tool("c1"), say("reasoning", "again"), tool("c2"), say("text", "done")]
    const activity = [act("c1", "read"), act("c2", "grep")]
    expect(shape(toSegments(parts, activity))).toBe("r read×1 r grep×1 t")
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
