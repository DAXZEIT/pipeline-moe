/**
 * Multiline draft helpers for the command line (pi's Editor arbitration,
 * fitted to our fixed-height layout). The draft is a plain string with real
 * \n; the cursor is a flat index into it. ↑/↓ move the cursor between lines
 * and only fall through to prompt history (↑ on the first line / ↓ on the
 * last) — see prompt-history.ts for that half of the arbitration.
 *
 * The input box renders at most MAX_INPUT_ROWS lines, windowed around the
 * cursor's line; the App books the extra rows in the Transcript's
 * reservedRows so a growing draft shrinks the conversation instead of
 * overflowing the frame (the Ink row-diffing corruption, 2026-07-09).
 */

export const MAX_INPUT_ROWS = 6

export interface RowCol {
  row: number
  col: number
}

/** Map a flat cursor index to its line/column. */
export function cursorRowCol(value: string, cursor: number): RowCol {
  const before = value.slice(0, cursor)
  const row = (before.match(/\n/g) ?? []).length
  const lastNl = before.lastIndexOf("\n")
  return { row, col: cursor - lastNl - 1 }
}

/** Start/end indices of the line the cursor sits on (end excludes the \n). */
export function lineBounds(value: string, cursor: number): { start: number; end: number } {
  const lastNl = value.lastIndexOf("\n", cursor - 1)
  const start = lastNl + 1
  const nextNl = value.indexOf("\n", cursor)
  return { start, end: nextNl === -1 ? value.length : nextNl }
}

/** New cursor after moving one line up/down keeping the column (clamped to
 *  the target line's length), or null when already on the first/last line —
 *  the caller falls through to history / scrolling. */
export function moveVertical(value: string, cursor: number, dir: -1 | 1): number | null {
  const lines = value.split("\n")
  const { row, col } = cursorRowCol(value, cursor)
  const target = row + dir
  if (target < 0 || target >= lines.length) return null
  let start = 0
  for (let i = 0; i < target; i++) start += lines[i].length + 1
  return start + Math.min(col, lines[target].length)
}

/** The window of lines to render: everything when it fits, else `max` lines
 *  around the cursor's line (clamped to the ends). */
export function visibleWindow(lineCount: number, cursorRow: number, max: number): { start: number; end: number } {
  if (lineCount <= max) return { start: 0, end: lineCount }
  let start = cursorRow - Math.floor(max / 2)
  start = Math.max(0, Math.min(start, lineCount - max))
  return { start, end: start + max }
}
