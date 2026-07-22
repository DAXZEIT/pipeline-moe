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

import stringWidth from "string-width"

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

/** A logical line soft-wrapped into visual rows no wider than `width` display
 *  columns. Each row is a substring (JS slice, so a caller can index the cursor
 *  into it); the flags mark the LAST row of each logical line so the renderer
 *  can distinguish a soft-wrap continuation from a real new line. */
export interface WrappedDraft {
  rows: string[]
  cursorRow: number
  /** String index into `rows[cursorRow]` — the visible cursor slot. */
  cursorCol: number
}

/** Break one logical line into visual segments no wider than `width` display
 *  columns, splitting at code-point boundaries. Concatenating the segments
 *  reproduces the line byte-for-byte, so cursor string-indices are preserved.
 *  An empty line yields a single empty segment (it still occupies a row). */
function wrapLine(line: string, width: number): string[] {
  if (line === "") return [""]
  const segs: string[] = []
  let cur = ""
  let curW = 0
  for (const ch of line) {
    const cw = stringWidth(ch) || 1
    if (curW + cw > width && cur !== "") {
      segs.push(cur)
      cur = ""
      curW = 0
    }
    cur += ch
    curW += cw
  }
  segs.push(cur)
  return segs
}

/**
 * Soft-wrap the whole draft to `width` display columns so a long line GROWS
 * the box (more visual rows) instead of being clipped with an ellipsis — and
 * the cursor stays visible. We pre-wrap ourselves rather than lean on Ink's
 * `wrap="wrap"` because the App reserves the draft's height up-front (the
 * 2026-07-09 row-diffing contract): we need the exact visual-row count, which
 * Ink's own wrapping hides. The cursor maps to a (row, col) slot; when it sits
 * at the very end of a FULL row an empty trailing row is added so its inverse
 * block never overflows the width (which would wrap and corrupt the frame).
 */
export function wrapDraft(value: string, cursor: number, width: number): WrappedDraft {
  const w = Math.max(1, width)
  const logical = value.split("\n")
  const rows: string[] = []
  let cursorRow = 0
  let cursorCol = 0
  let lineStart = 0
  for (const line of logical) {
    const segs = wrapLine(line, w)
    const base = rows.length
    for (const s of segs) rows.push(s)
    // The cursor lands in this logical line when its flat index falls within
    // [lineStart, lineStart+line.length] (the upper bound is the slot just
    // before the '\n', i.e. end-of-line).
    const off = cursor - lineStart
    if (off >= 0 && off <= line.length) {
      let acc = 0
      for (let si = 0; si < segs.length; si++) {
        const len = segs[si].length
        // Boundary (off === acc+len) rolls to the next segment's start unless
        // this is the last one — so typing the (width+1)-th char shows the
        // cursor at the head of the fresh row, terminal-style.
        if (off < acc + len || si === segs.length - 1) {
          cursorRow = base + si
          cursorCol = off - acc
          break
        }
        acc += len
      }
    }
    lineStart += line.length + 1 // skip the '\n'
  }
  // Cursor at the end of a row that is already full → give it its own row so
  // the inverse block doesn't push the line one column past the width.
  if (rows.length > 0 && cursorRow === rows.length - 1) {
    const last = rows[cursorRow]
    if (cursorCol === last.length && stringWidth(last) >= w) {
      rows.push("")
      cursorRow = rows.length - 1
      cursorCol = 0
    }
  }
  return { rows, cursorRow, cursorCol }
}
