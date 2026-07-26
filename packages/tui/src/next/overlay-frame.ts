// The box every overlay lives in, as a pure function of its contents.
//
// pi-tui has no bordered container — `Box` applies padding and a background, and
// nothing else. So the border is ours, and putting it in one framework-free
// function buys the same thing chrome-lines.ts bought: the width invariant is
// asserted once, in a test, rather than trusted five times over.
//
// Width matters more here than anywhere else in the client. pi-tui THROWS on a
// rendered line wider than the viewport, an overlay is composited at a column
// offset inside that viewport, and its content is the least predictable text in
// the app: model refs 60 characters long, preset names from disk, error messages
// from the server. Every line that leaves this module is fitted and padded to
// exactly the width — see the ruler note below for which width that is.

import chalk from "chalk"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

// ONE RULER, AND IT IS pi-tui's — corrected in Phase 4 after counting columns on
// a real terminal.
//
// `▶` (U+25B6) is East Asian Ambiguous: `string-width` calls it 2 columns,
// pi-tui's `visibleWidth` calls it 1. Phase 1 found the disagreement in the
// chrome and took the conservative side — fit under BOTH measures, on the theory
// that a line pi-tui believes fits might still soft-wrap. That theory is wrong
// here, and it cost real content two ways at once:
//
//   - PADDING used string-width, so a focused form row (the only line in the app
//     carrying a `▶`) came out one column short of its own border. Measured live
//     at 120 columns: every framed line 108 wide except the focused one, at 107.
//   - FITTING used the stricter measure, so a line that exactly filled the box
//     got truncated for being "77 wide" when the terminal drew 76 — which ate the
//     right-hand column of a `twoColumn` row (`@scout` → `@s…`).
//
// kitty and tmux both draw `▶` in one column, which is also what pi-tui's overlay
// compositor and its line-length check assume. So there is one ruler: pi-tui's.
// Being conservative bought nothing and spent a column.
//
// The gate-3 tests did not catch either half, because they measured with the same
// overcounting ruler as the code: `stringWidth(line) === width` passes when both
// sides are wrong about the same glyph. They measure with `visibleWidth` now.
//
// `chrome-lines.ts` keeps its own accounting — it is shared with the Ink client,
// whose layer measures differently again, and it is not this module's to change.

/** Columns this string actually occupies on screen. pi-tui's own measure, which
 *  is what its overlay compositor and its line-length check both use. */
export function visible(s: string): number {
  return visibleWidth(s)
}

/** Truncate to `width` columns as pi-tui counts them. */
export function fitLine(line: string, width: number): string {
  let target = width
  let out = truncateToWidth(line, target)
  while (target > 0 && visible(out) > width) {
    target -= 1
    out = truncateToWidth(line, target)
  }
  return out
}

export interface FrameOptions {
  title: string
  /** Right-hand side of the title row: a counter, a filter echo. Dim. */
  titleRight?: string
  body: string[]
  /** The key legend on the last row. Dim. */
  hint: string
  /** chalk colour name for the border and title. Magenta = a picker, cyan = a
   *  board or an editor — the same one-colour-per-meaning rule as the chrome. */
  color: "magenta" | "cyan" | "green" | "yellow"
}

/** A rounded box: title row, body, hint row. `width` is the OUTER width, so the
 *  caller can hand it straight to pi-tui without arithmetic. */
export function frame(o: FrameOptions, width: number): string[] {
  const w = Math.max(4, width)
  const inner = w - 4 // two border columns + one space of padding each side
  const paint = chalk[o.color]
  const pad = (s: string): string => {
    const fitted = fitLine(s, inner)
    const gap = inner - visible(fitted)
    return paint("│") + " " + fitted + " ".repeat(Math.max(0, gap)) + " " + paint("│")
  }
  const titleRow = chalk.bold(paint(o.title)) + (o.titleRight ? chalk.dim("  " + o.titleRight) : "")
  return [
    paint("╭" + "─".repeat(w - 2) + "╮"),
    pad(titleRow),
    ...o.body.map(pad),
    pad(chalk.dim(o.hint)),
    paint("╰" + "─".repeat(w - 2) + "╯"),
  ]
}

/** Two-column row: `left` at the margin, `right` pushed to the far edge and
 *  sacrificed first when there is no room. This is the shape Ink gave us with
 *  `justifyContent="space-between"` and it carries real information — an agent's
 *  model, a preset's summary, a task's owner. */
export function twoColumn(left: string, right: string, width: number): string {
  if (!right) return fitLine(left, width)
  const l = fitLine(left, width)
  const room = width - visible(l) - 1
  if (room < 4) return l // no honest room for the hint; the label wins
  const r = fitLine(right, room)
  return l + " ".repeat(Math.max(1, width - visible(l) - visible(r))) + r
}

/** `▲ more` / `▼ more` markers, so a windowed list never looks complete when it
 *  is not. A blank line rather than nothing: the box must not change height as
 *  the cursor moves, or every line below it is rewritten on an arrow key. */
export function moreMarker(present: boolean, arrow: "▲" | "▼"): string {
  return present ? chalk.dim(`  ${arrow} more`) : " "
}

/** Centre a window of `count` rows on `cursor`, clamped at both ends. A pure
 *  derivation from the cursor, so there is no scroll state to drift. */
export function windowStart(cursor: number, total: number, count: number): number {
  if (total <= count) return 0
  return Math.max(0, Math.min(cursor - Math.floor(count / 2), total - count))
}
