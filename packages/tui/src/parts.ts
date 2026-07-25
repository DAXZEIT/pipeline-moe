// Turning a turn's chronological `parts` into display segments
// (docs/interleaved-turns.md, block 3).
//
// `parts` says WHAT happened in WHAT order; a tool part is a pointer into the
// entry's `activity`. This module resolves those pointers and applies the two
// reductions the TUI needs before anything is drawn:
//
//   1. consecutive same-tool ok calls still aggregate into one ×N group, the
//      same way the grouped layout did — the interleaved view would otherwise
//      spend six lines on "read ×6" without adding a single thought between
//      them;
//   2. the SEQUENCE is windowed, because at ~16 tool calls per turn even a
//      fully collapsed turn runs past 30 lines. Errors are pinned out of the
//      window, exactly as windowActivity already does inside a tool block.

import type { ToolActivity, TurnPart } from "@pipeline-moe/client-core"
import { groupActivity, type ActivityGroup } from "./activity.js"

/** One drawable unit of an interleaved turn. */
export type DisplaySegment =
  | { kind: "reasoning" | "text"; content: string }
  | { kind: "tools"; group: ActivityGroup }

/** How many trailing segments the windowed sequence shows. */
export const SEQUENCE_WINDOW = 12

/** Below this, folding the middle is a net loss: the `⋯ N hidden` marker costs
 *  a line of its own, and a collapsed segment is one line. Found live
 *  (2026-07-25) on an 11-segment turn where the window engaged to hide 2 —
 *  three lines of chrome to save two lines of content, and the turn lost its
 *  first tool call for nothing. */
export const MIN_FOLD = 3

/** Resolve tool pointers and aggregate runs of them, preserving order.
 *
 *  A tool part whose id is not in `activity` is dropped rather than drawn as a
 *  placeholder: it can only happen if the two fields disagree, and an invented
 *  row would be a worse lie than a missing one. */
export function toSegments(parts: TurnPart[], activity: ToolActivity[] | undefined): DisplaySegment[] {
  const byId = new Map((activity ?? []).map((a) => [a.toolCallId, a]))
  const segments: DisplaySegment[] = []
  let run: ToolActivity[] = []

  const flushRun = () => {
    if (run.length === 0) return
    for (const group of groupActivity(run)) segments.push({ kind: "tools", group })
    run = []
  }

  for (const part of parts) {
    if (part.type === "tool") {
      const act = byId.get(part.toolCallId)
      if (act) run.push(act)
      continue
    }
    flushRun()
    const content = part.content.trim()
    // Live segments are not trimmed at the source (a trailing space may still
    // be followed by more text), so an empty one is normal mid-stream.
    if (content) segments.push({ kind: part.type, content })
  }
  flushRun()
  return segments
}

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
