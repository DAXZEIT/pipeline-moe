import { describe, expect, test } from "vitest"
import { TurnSegmenter, appendBodyMarker } from "../turn-parts.js"
import type { TurnPart } from "../types.js"

// Block 1 of docs/interleaved-turns.md. These are PURE tests on a synthetic
// event sequence — no session, no room, no renderer. What they pin down is the
// only thing block 1 claims: that the order a turn happened in survives
// collection, which today's two `+=` buffers destroy.
//
// The sequence in `shape()` below is the one the design doc argues about:
// reason → tool → reason → text → tool. Under the current buffers that
// collapses to one reasoning blob (with the "…push.Root typecheck…" glue seam
// visible in real persisted transcripts), one text blob, and a tool list.

/** Compact shape of a parts array, for assertions that are about ORDER. */
function shape(parts: TurnPart[] | undefined): string {
  return (parts ?? []).map((p) => (p.type === "tool" ? `🔧${p.toolCallId}` : p.type[0])).join(" ")
}

describe("TurnSegmenter", () => {
  test("records the order the turn actually happened in", () => {
    const seg = new TurnSegmenter()
    seg.delta("reasoning", "I should look at the file")
    seg.tool("call-1")
    seg.delta("reasoning", "that confirms it")
    seg.delta("text", "Here is what I found.")
    seg.tool("call-2")
    const parts = seg.finish()

    expect(shape(parts)).toBe("r 🔧call-1 r t 🔧call-2")
    // The information the grouped layout cannot express: reasoning BEFORE and
    // AFTER a tool call, as two distinct segments rather than one blob.
    expect(parts?.[0]).toMatchObject({ type: "reasoning", content: "I should look at the file" })
    expect(parts?.[2]).toMatchObject({ type: "reasoning", content: "that confirms it" })
  })

  test("contiguous deltas of the same type stay ONE segment", () => {
    const seg = new TurnSegmenter()
    for (const chunk of ["I ", "should ", "look"]) seg.delta("reasoning", chunk)
    seg.tool("call-1")
    const parts = seg.finish()
    expect(shape(parts)).toBe("r 🔧call-1")
    expect((parts?.[0] as { content: string }).content).toBe("I should look")
  })

  test("a type flip alone opens a new segment — no tool needed", () => {
    // reasoning → text → reasoning inside a single assistant message: the
    // reason the boundary rule is the delta type, not pi's message boundary.
    const seg = new TurnSegmenter()
    seg.delta("reasoning", "hm")
    seg.delta("text", "One moment.")
    seg.delta("reasoning", "back to thinking")
    expect(shape(seg.finish())).toBe("r t r")
  })

  test("lines counts the segment as authored", () => {
    const seg = new TurnSegmenter()
    seg.delta("reasoning", "line one\nline two\nline three")
    seg.tool("call-1")
    seg.delta("text", "single")
    const parts = seg.finish()
    expect((parts?.[0] as { lines: number }).lines).toBe(3)
    expect((parts?.[2] as { lines: number }).lines).toBe(1)
  })

  test("segments are trimmed, and a whitespace-only run is dropped entirely", () => {
    // Models routinely emit a trailing "\n\n" before a tool call. A part made
    // only of that would render as an empty collapsed line.
    const seg = new TurnSegmenter()
    seg.delta("reasoning", "  thinking  \n\n")
    seg.tool("call-1")
    seg.delta("text", "\n \n")
    seg.tool("call-2")
    const parts = seg.finish()
    expect(shape(parts)).toBe("r 🔧call-1 🔧call-2")
    expect((parts?.[0] as { content: string }).content).toBe("thinking")
  })

  test("a tool-only turn still yields parts; an empty turn yields none", () => {
    const tools = new TurnSegmenter()
    tools.tool("call-1")
    tools.tool("call-2")
    expect(shape(tools.finish())).toBe("🔧call-1 🔧call-2")

    const empty = new TurnSegmenter()
    expect(empty.finish()).toBeUndefined()

    // Whitespace-only is empty too — no parts, so the renderer falls back.
    const blank = new TurnSegmenter()
    blank.delta("text", "   \n")
    expect(blank.finish()).toBeUndefined()
  })

  test("reset() starts a clean turn — no bleed from the previous one", () => {
    // Participant reuses one segmenter across every turn of a seat, resetting
    // where it clears the buffers. A leak here would attribute one agent's
    // reasoning to the next turn (and, on a fused seat, to another hat).
    const seg = new TurnSegmenter()
    seg.delta("reasoning", "turn one")
    seg.tool("call-1")
    seg.finish()

    seg.reset()
    seg.delta("text", "turn two")
    const parts = seg.finish()
    expect(shape(parts)).toBe("t")
    expect((parts?.[0] as { content: string }).content).toBe("turn two")
  })

  test("finish() closes the open segment without needing a trailing event", () => {
    // The common case: a turn ends on its reply, with nothing after it.
    const seg = new TurnSegmenter()
    seg.tool("call-1")
    seg.delta("text", "Done.")
    const parts = seg.finish()
    expect(shape(parts)).toBe("🔧call-1 t")
    expect((parts?.[1] as { lines: number }).lines).toBe(1)
  })

  test("parts stay ordered by construction, not by timestamp", () => {
    // Text and reasoning deltas carry no per-delta timestamp, so a sort is
    // impossible — the array position IS the ordering. Two segments produced
    // inside the same millisecond must still keep their order.
    const seg = new TurnSegmenter()
    seg.delta("reasoning", "a")
    seg.delta("text", "b")
    seg.delta("reasoning", "c")
    const parts = seg.finish() ?? []
    expect(parts.map((p) => (p as { content: string }).content)).toEqual(["a", "b", "c"])
  })
})

describe("appendBodyMarker", () => {
  // room.ts appends " _(interrupted — partial)_" to the BODY after the turn
  // (knownissues.md F7 salvage). A renderer drawing the parts would otherwise
  // show a truncated reply with no sign it was cut off.
  const marker = " _(interrupted — partial)_"

  test("lands on the last text part and refreshes its line count", () => {
    const seg = new TurnSegmenter()
    seg.delta("text", "first")
    seg.tool("call-1")
    seg.delta("text", "second\nline")
    const parts = appendBodyMarker(seg.finish(), marker) ?? []

    expect((parts[0] as { content: string }).content).toBe("first")
    expect((parts[2] as { content: string }).content).toBe(`second\nline${marker}`)
    expect((parts[2] as { lines: number }).lines).toBe(2)
  })

  test("never lands on a reasoning part", () => {
    const seg = new TurnSegmenter()
    seg.delta("text", "the reply")
    seg.delta("reasoning", "afterthought")
    const parts = appendBodyMarker(seg.finish(), marker) ?? []
    expect((parts[0] as { content: string }).content).toBe(`the reply${marker}`)
    expect((parts[1] as { content: string }).content).toBe("afterthought")
  })

  test("appends a text part when the turn was cut off before writing any prose", () => {
    const seg = new TurnSegmenter()
    seg.delta("reasoning", "let me check")
    seg.tool("call-1")
    const parts = appendBodyMarker(seg.finish(), marker) ?? []
    expect(shape(parts)).toBe("r 🔧call-1 t")
    expect((parts[2] as { content: string }).content).toBe(marker.trim())
  })

  test("a normal turn (empty marker) is returned untouched", () => {
    const seg = new TurnSegmenter()
    seg.delta("text", "all good")
    const parts = seg.finish()
    expect(appendBodyMarker(parts, "")).toBe(parts)
    expect(appendBodyMarker(undefined, marker)).toBeUndefined()
  })
})
