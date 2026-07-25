// Chronological segmentation of a turn (docs/interleaved-turns.md).
//
// A turn currently collects into two `+=` buffers and one activity map, which
// destroys the ordering at COLLECTION time: reason → tool → reason → reply
// arrives as one reasoning blob, one text blob and a tool list, with no
// ordering relation between the three. That is why the grouped
// CoT-box/tool-box/text-box layout is the only thing the data supports today.
//
// This segmenter runs alongside those buffers (it does not replace them —
// buildContext, roomTranscriptTokens and the receipts all still read
// text/reasoning/activity) and records the ORDER: one part per contiguous run
// of same-type deltas, one part per tool call, in arrival order.
//
// Boundary rule: close the open segment when the delta type flips
// (text ↔ reasoning) or when a tool starts. Deliberately NOT pi's
// assistant-message boundary event — the flip rule reproduces exactly the
// seams already visible in persisted transcripts (a reasoning blob reading
// "…safe to push.Root typecheck passed…" is a missing space at a `+=` seam,
// i.e. a CoT segment that happened after a tool call), it also catches
// reasoning → text → reasoning inside a single message, and it costs no
// dependency on a pi API surface we would have to track across bumps.

import type { TurnPart, TurnTextPart } from "./types.js"

/** Accumulates a turn's parts in arrival order.
 *
 *  The open text/reasoning segment is ALWAYS the last element of `parts` while
 *  it is open, and tool parts are only appended after closing it — so the
 *  array is ordered by construction and never needs a sort (text and reasoning
 *  deltas carry no timestamp of their own to sort by). */
export class TurnSegmenter {
  private parts: TurnPart[] = []
  /** The last element of `parts` while a text/reasoning run is open. */
  private open: TurnTextPart | null = null

  /** Start a fresh turn. Called from the same place the buffers are cleared. */
  reset(): void {
    this.parts = []
    this.open = null
  }

  delta(type: "reasoning" | "text", delta: string): void {
    let part = this.open
    if (!part || part.type !== type) {
      this.close()
      part = { type, content: "", ts: Date.now() }
      this.parts.push(part)
      this.open = part
    }
    part.content += delta
  }

  /** A tool call started — it closes whatever segment was running. The part
   *  REFERENCES its ToolActivity by id instead of copying it, so the live path
   *  that flips a tool running → ok in place keeps working untouched. */
  tool(toolCallId: string): void {
    this.close()
    this.parts.push({ type: "tool", toolCallId })
  }

  /** Close the turn and hand over its parts. `undefined` when the turn
   *  produced nothing orderable — the renderer's grouped fallback (which is
   *  also what every pre-`parts` entry in sessions/ gets) covers that case.
   *
   *  Note this returns parts even for a trivial turn whose order matches the
   *  grouped layout anyway. Emitting conditionally would buy a few bytes and
   *  cost predictability: "parts present" must mean one thing, or block 2's
   *  live-equals-persisted assertion has to encode the exception too. */
  finish(): TurnPart[] | undefined {
    this.close()
    return this.parts.length > 0 ? this.parts : undefined
  }

  private close(): void {
    const part = this.open
    if (!part) return
    this.open = null
    const content = part.content.trim()
    // A run that was pure whitespace carries no information and would render
    // as an empty collapsed line. It is the last element by the invariant
    // above, so dropping it keeps the array ordered.
    if (!content) {
      this.parts.pop()
      return
    }
    part.content = content
  }
}

/** Mirror a body marker that room.ts appends AFTER the turn (the
 *  ` _(interrupted — partial)_` / ` _(failed — partial…)_` suffixes on a
 *  salvaged turn, knownissues.md F7) onto the last text part.
 *
 *  Without this the marker lives only in `entry.text`, and a renderer drawing
 *  the parts would show the partial reply with no sign that it was cut off —
 *  the salvage marker exists precisely so a partial turn cannot be mistaken
 *  for a complete one. Falls back to appending a text part when the turn
 *  ended with a tool call and produced no prose at all. */
export function appendBodyMarker(parts: TurnPart[] | undefined, marker: string): TurnPart[] | undefined {
  if (!parts || !marker) return parts
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part.type === "text") {
      const next = [...parts]
      next[i] = { ...part, content: part.content + marker }
      return next
    }
  }
  return [...parts, { type: "text", content: marker.trim(), ts: Date.now() }]
}
