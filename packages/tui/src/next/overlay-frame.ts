// The box every overlay lives in, as a pure function of its contents.
//
// pi-tui has no bordered container — `Box` applies padding and a background, and
// nothing else. So the border is ours, and putting it in one framework-free
// function buys the same thing chrome-lines.ts bought: the width invariant is
// asserted once, in a test, rather than trusted five times over.
//
// The width rule is stricter here than anywhere else in the client. pi-tui
// THROWS on a rendered line wider than the viewport, an overlay is composited at
// a column offset inside that viewport, and its content is the least predictable
// text in the app: model refs 60 characters long, preset names from disk, error
// messages from the server. Every line that leaves this module is fitted.

import chalk from "chalk"
import stringWidth from "string-width"
import { truncateToWidth } from "@earendil-works/pi-tui"

/** Strip ANSI and measure with the stricter of the two width measures — the same
 *  disagreement that bit the chrome (`▶` is East Asian Ambiguous: string-width
 *  says 2 columns, pi-tui's measure says 1). */
export function fitLine(line: string, width: number): string {
  const visible = (s: string): number => stringWidth(s.replace(/\x1b\[[0-9;]*m/g, ""))
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
    const gap = inner - stringWidth(fitted.replace(/\x1b\[[0-9;]*m/g, ""))
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
  const vis = (s: string): number => stringWidth(s.replace(/\x1b\[[0-9;]*m/g, ""))
  if (!right) return fitLine(left, width)
  const l = fitLine(left, width)
  const room = width - vis(l) - 1
  if (room < 4) return l // no honest room for the hint; the label wins
  const r = fitLine(right, room)
  return l + " ".repeat(Math.max(1, width - vis(l) - vis(r))) + r
}

/** `▲ more` / `▼ more` markers, so a windowed list never looks complete when it
 *  is not. A blank line rather than nothing: the box must not change height as
 *  the cursor moves, or every line below it is rewritten on an arrow key. */
export function moreMarker(present: boolean, arrow: "▲" | "▼"): string {
  return present ? chalk.dim(`  ${arrow} more`) : " "
}

/** Centre a window of `visible` rows on `cursor`, clamped at both ends. A pure
 *  derivation from the cursor, so there is no scroll state to drift. */
export function windowStart(cursor: number, total: number, visible: number): number {
  if (total <= visible) return 0
  return Math.max(0, Math.min(cursor - Math.floor(visible / 2), total - visible))
}
