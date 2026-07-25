// The TUI's line-budget reduction over a turn's display segments
// (docs/interleaved-turns.md, block 3).
//
// Resolving `parts` into segments — pointers into `activity`, ×N aggregation —
// is shared with the web renderer and lives in client-core. What is left here
// is the one thing a terminal needs and a scrolling page does not: at ~16 tool
// calls per turn even a fully collapsed turn runs past 30 lines, so the
// SEQUENCE itself is windowed. Errors are pinned out of the window, exactly as
// windowActivity already does inside a tool block.

import { toSegments, type DisplaySegment } from "@pipeline-moe/client-core"

export { toSegments }
export type { DisplaySegment }

/** How many trailing segments the windowed sequence shows. */
export const SEQUENCE_WINDOW = 12

/** Below this, folding the middle is a net loss: the `⋯ N hidden` marker costs
 *  a line of its own, and a collapsed segment is one line. Found live
 *  (2026-07-25) on an 11-segment turn where the window engaged to hide 2 —
 *  three lines of chrome to save two lines of content, and the turn lost its
 *  first tool call for nothing. */
export const MIN_FOLD = 3

export interface WindowedSequence {
  /** The opening segment — how the turn started is the other half of its
   *  shape, and it is the first thing to scroll out of a tail-only window. */
  head: DisplaySegment[]
  /** Failed tool groups from the hidden middle. An error must never be the
   *  thing a truncation eats (same guarantee as windowActivity). */
  pinnedErrors: DisplaySegment[]
  /** How many segments the middle swallowed, pinned errors excluded. */
  hidden: number
  tail: DisplaySegment[]
}

/** Keep the first segment and the last `size`; collapse the middle.
 *  Short turns pass through untouched. */
export function windowSequence(segments: DisplaySegment[], size = SEQUENCE_WINDOW): WindowedSequence {
  const passthrough = { head: segments, pinnedErrors: [], hidden: 0, tail: [] }
  if (segments.length < size + 1 + MIN_FOLD) return passthrough
  const head = segments.slice(0, 1)
  const tail = segments.slice(-size)
  const middle = segments.slice(1, segments.length - size)
  const pinnedErrors = middle.filter((s) => s.kind === "tools" && s.group.status === "error")
  return { head, pinnedErrors, hidden: middle.length - pinnedErrors.length, tail }
}
