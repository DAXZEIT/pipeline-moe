// One form engine, four forms.
//
// SETTINGSLIST DOES NOT FIT — the plan's named unknown, answered.
//
// pi-tui's `SettingsList` is a label→value list where ⏎ cycles a fixed `values`
// array or opens a submenu that REPLACES the list's render. Four things our forms
// need are simply not in it:
//
//   1. Text edited IN PLACE. Nine of the member card's fourteen rows are free
//      text. Routing each through a submenu turns "type a name" into a modal
//      dive — strictly worse than what the Ink forms already do.
//   2. A submit action. `SettingsList` has a per-row `onChange` and an
//      `onCancel`; ours are create/save forms whose validation runs once, at
//      submit, and whose error must stay on screen next to the field. There is
//      no row kind for `[ Create ]`.
//   3. Multi-select. `tools` is seventeen checkboxes with a horizontal cursor and
//      space to toggle; `values` cycles one value at a time.
//   4. Interleaved non-rows. The room form prints a live persona preview BETWEEN
//      its fields; there is no such thing in a settings list.
//
// So the engine is ours — but it is written ONCE. The four Ink forms were four
// copies of the same keyboard loop (↑↓ between rows, type to edit, ←→ to cycle,
// space to toggle, ⏎ to advance or submit, esc to cancel), and `MemberEditor`
// had already half-extracted it into a local `Row` union. That union, finished
// and made framework-free, is this file. What shrinks 1 340 lines is not a
// library component; it is not writing the loop four times.
//
// TWO THINGS THIS ENGINE DOES THAT THE INK FORMS COULD NOT
//
// It windows. pi-tui's `maxHeight` truncates rather than shrinks (the Phase 3
// finding), and the member card is fourteen rows plus wrapped chip lines — on a
// short terminal the `[ Done ]` row and the key legend were the first things off
// the bottom. Rows are windowed around the focused one, with the same `▲/▼ more`
// markers the task board uses, so the action is always reachable.
//
// And it wraps its own chips. Ink handed that to Yoga via `flexWrap`, which is
// also where nested `<Text>` runs came back with fragmented widths (the lesson
// in CommandLine.tsx). Here a chip row is measured and broken explicitly, and
// the width invariant is asserted in a test rather than trusted.

import chalk from "chalk"
import { matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui"
import { backspaceText } from "../preset-composer"
import { fitLine, frame, moreMarker, visible, type FrameOptions } from "./overlay-frame"

/** A field the user types into. */
export interface TextRow {
  kind: "text"
  label: string
  /** Shown dim when the value is empty. */
  placeholder?: string
  /** Dim text AFTER the value: a derived `@slug`, a "comma-separated" reminder. */
  hint?: () => string | undefined
  /** Sanitize each arriving chunk. Defaults to flattening newlines and dropping
   *  control characters; a preset name narrows it further. */
  filter?: (chunk: string) => string
  /** Collapse to one truncated line while unfocused — for prompts. */
  long?: boolean
  /** Runs on ⏎ BEFORE the cursor advances — "commit this field". The composer's
   *  free-text model row uses it to leave custom mode on the way out. */
  onEnter?: () => void
  get: () => string
  /** MUST take an updater, never a value. A pasted emoji can arrive as two stdin
   *  events in one tick, and a read-then-set against a stale draft loses the
   *  first half — found live in the Ink composer (🐺 → a lone surrogate). */
  update: (fn: (v: string) => string) => void
}

/** ←→ steps through a list. ⏎ optionally opens the full catalogue instead of
 *  advancing, which is how a 300-model list stays out of arrow-key territory. */
export interface CycleRow {
  kind: "cycle"
  label: string
  view: () => string
  /** A hex colour to paint the value with, prefixed by a `■■` swatch. */
  swatch?: () => string | undefined
  left: () => void
  right: () => void
  enter?: () => void
  /** Replaces "⏎ next" in the legend when `enter` is set. */
  enterHint?: string
}

/** ←→ moves a cursor along the chips, space flips the one under it. */
export interface ChipsRow {
  kind: "chips"
  label: string
  items: string[]
  on: (item: string) => boolean
  toggle: (item: string) => void
  /** Paint an ON chip cyan instead of green — the flags row, where "parallel"
   *  means something different from "granted". */
  accent?: (item: string) => "green" | "cyan"
}

/** Lines that are not a field: a preview, an explanation, a blank. Skipped by
 *  the cursor, so it can never land somewhere with nothing to do. */
export interface NoteRow {
  kind: "note"
  lines: () => string[]
}

/** The submit row. ⏎ on it runs `onSubmit`; there is exactly one per form. */
export interface ActionRow {
  kind: "action"
  label: () => string
}

export type FormRow = TextRow | CycleRow | ChipsRow | NoteRow | ActionRow

export interface FormOptions {
  title: () => string
  color: FrameOptions["color"]
  /** Called every render and every keystroke — rows may appear and disappear
   *  (the room form's Model row exists only in solo mode) and the focus index
   *  renumbers with them, exactly as it did under Ink. */
  rows: () => FormRow[]
  onSubmit: () => void
  onCancel: () => void
  /** Extra legend text, prepended to the row-specific segments. */
  extraHint?: () => string | undefined
  /** What esc actually does, for the tail of the legend. Defaults to "esc cancel".
   *  The member card overrides it because esc there COMMITS — a legend that says
   *  "cancel" next to a key that saves is worse than no legend at all. */
  cancelHint?: string
}

/** Rows the terminal has. Same injection point as the overlays: `render` is
 *  handed a width and nothing else, so a windowing component must ask. */
export type Rows = () => number

const rowsOf: Rows = () => process.stdout.rows ?? 24

const CLEAN = (chunk: string): string =>
  // Pastes and coalesced keystrokes arrive as one chunk with \r\n embedded; raw
  // control characters shred the box, so newlines become spaces and the rest go.
  chunk.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "")

/** Break a chip row into as many lines as the width needs. Returns at least one
 *  line even when a single chip is wider than the terminal — a form that renders
 *  nothing reads as a crash. */
export function wrapChips(chips: string[], width: number, indent: string): string[] {
  const out: string[] = []
  let line = indent
  let used = visible(indent)
  for (const chip of chips) {
    const w = visible(chip)
    if (used > visible(indent) && used + w > width) {
      out.push(line)
      line = indent
      used = visible(indent)
    }
    line += chip
    used += w
  }
  out.push(line)
  return out.map((l) => fitLine(l, width))
}

/** How many lines of rows fit. Derived from the SAME numbers the host passes to
 *  `showOverlay` — `maxHeight: "80%"` — because pi-tui's maxHeight truncates from
 *  the bottom, and the bottom is where `[ Create ]` and the key legend live.
 *
 *  80% of the screen, less the four frame lines (two borders, title, legend), less
 *  the two `▲/▼` marker lines a windowed form always prints, less the error line
 *  when there is one. Exported so the arithmetic is asserted rather than trusted:
 *  if this is one too generous, a short terminal silently loses the submit row. */
export function formBudget(rows: number, hasError: boolean): number {
  return Math.max(3, Math.floor(rows * 0.8) - 6 - (hasError ? 1 : 0))
}

/** Choose which rows to show. Grows outward from the focused row until the line
 *  budget runs out, so the focused field and the action row below it survive a
 *  short screen. Pure, and the reason the member card is usable at 24 rows. */
export function windowRows(
  groups: { lines: number; focusable: boolean }[],
  focus: number,
  budget: number,
): { start: number; end: number } {
  const total = groups.reduce((n, g) => n + g.lines, 0)
  if (total <= budget) return { start: 0, end: groups.length }
  let start = focus
  let end = focus + 1
  let used = groups[focus]?.lines ?? 0
  // Down first: the action row is at the bottom of every form, and losing it is
  // worse than losing the title fields the user has already filled in.
  for (;;) {
    const down = end < groups.length ? groups[end]!.lines : Infinity
    const up = start > 0 ? groups[start - 1]!.lines : Infinity
    if (used + Math.min(down, up) > budget) break
    if (down <= up) {
      used += down
      end += 1
    } else {
      used += up
      start -= 1
    }
  }
  return { start, end }
}

export class FormComponent implements Component, Focusable {
  focused = false
  private focus = 0
  /** One cursor shared by every chip row, clamped per row — the member card has
   *  three tool groups and the Ink version shared a cursor across them too. */
  private chipCursor = 0
  private error: string | null = null

  constructor(
    private opts: FormOptions,
    private rows: Rows = rowsOf,
  ) {}

  invalidate(): void {}

  /** Show a validation or server failure. A swallowed rejection leaves Create
   *  looking like it did nothing at all. */
  setError(msg: string | null): void {
    this.error = msg
  }

  /** Send the cursor to a named row — `save()` wants focus back on the field it
   *  is complaining about. */
  focusLabel(label: string): void {
    const i = this.opts.rows().findIndex((r) => "label" in r && r.label === label)
    if (i >= 0) this.focus = i
  }

  private focusable(rows: FormRow[]): number[] {
    return rows.map((r, i) => (r.kind === "note" ? -1 : i)).filter((i) => i >= 0)
  }

  /** Clamp onto a focusable row. Called before every use of `this.focus`,
   *  because the row list changes shape underneath it. */
  private current(rows: FormRow[]): number {
    const ok = this.focusable(rows)
    if (ok.length === 0) return -1
    if (ok.includes(this.focus)) return this.focus
    const next = ok.find((i) => i >= this.focus)
    return next ?? ok[ok.length - 1]!
  }

  private move(rows: FormRow[], delta: number): void {
    const ok = this.focusable(rows)
    if (ok.length === 0) return
    const at = ok.indexOf(this.current(rows))
    this.focus = ok[Math.max(0, Math.min(ok.length - 1, at + delta))]!
  }

  handleInput(data: string): void {
    const rows = this.opts.rows()
    if (matchesKey(data, "escape")) return this.opts.onCancel()
    const i = this.current(rows)
    const row = i >= 0 ? rows[i] : undefined
    if (!row) return

    if (matchesKey(data, "up")) return this.move(rows, -1)
    if (matchesKey(data, "down") || matchesKey(data, "tab")) return this.move(rows, +1)
    if (matchesKey(data, "enter")) {
      if (row.kind === "action") return this.opts.onSubmit()
      if (row.kind === "cycle" && row.enter) return row.enter()
      if (row.kind === "text") row.onEnter?.()
      return this.move(rows, +1)
    }

    if (row.kind === "cycle") {
      if (matchesKey(data, "left")) row.left()
      else if (matchesKey(data, "right")) row.right()
      return
    }

    if (row.kind === "chips") {
      const n = row.items.length
      if (n === 0) return
      if (matchesKey(data, "left")) this.chipCursor = (this.chipCursor - 1 + n) % n
      else if (matchesKey(data, "right")) this.chipCursor = (this.chipCursor + 1) % n
      else if (data === " ") {
        this.error = null
        row.toggle(row.items[Math.min(this.chipCursor, n - 1)]!)
      }
      return
    }

    if (row.kind !== "text") return
    if (matchesKey(data, "backspace")) {
      this.error = null
      // Code-point-safe: slice(0, -1) splits the emoji in an Icon field.
      return row.update(backspaceText)
    }
    // Chords belong to the app, not to the field.
    if (data.length > 1 && !/^[\u0020-\u007e\u00a0-\uffff]/.test(data)) return
    const clean = (row.filter ?? CLEAN)(data)
    if (clean) {
      this.error = null
      row.update((v) => v + clean)
    }
  }

  private renderRow(row: FormRow, focused: boolean, inner: number): string[] {
    const marker = focused ? chalk.green("▶ ") : "  "
    switch (row.kind) {
      case "note":
        return row.lines().map((l) => fitLine(l, inner))
      case "action": {
        const label = `${focused ? "▶ " : "  "}[ ${row.label()} ]`
        return [fitLine(focused ? chalk.green.inverse(label) : chalk.gray(label), inner)]
      }
      case "text": {
        const value = row.get()
        const shown = row.long && !focused && value.length > 60 ? value.slice(0, 57) + "…" : value
        const hint = row.hint?.()
        const body = shown
          ? shown + (focused ? chalk.green("▌") : "")
          : chalk.dim(row.placeholder ?? "") + (focused ? chalk.green("▌") : "")
        return [fitLine(marker + chalk.dim(`${row.label}: `) + body + (hint ? chalk.dim(` ${hint}`) : ""), inner)]
      }
      case "cycle": {
        const colour = row.swatch?.()
        const painted = colour ? chalk.hex(colour)(`■■ ${row.view()}`) : chalk.cyan(row.view())
        const value = focused ? `${chalk.dim("‹ ")}${painted}${chalk.dim(" ›")}` : painted
        return [fitLine(marker + chalk.dim(`${row.label}: `) + value, inner)]
      }
      case "chips": {
        const n = row.items.length
        const chips = row.items.map((t, j) => {
          const on = row.on(t)
          const cur = focused && j === Math.min(this.chipCursor, Math.max(0, n - 1))
          const text = `${on ? "■" : "□"}${t}  `
          if (cur) return chalk.inverse(text)
          if (!on) return chalk.dim(text)
          return (row.accent?.(t) === "cyan" ? chalk.cyan : chalk.green)(text)
        })
        const head = marker + chalk.dim(`${row.label}${row.label ? ": " : ""}`)
        const first = wrapChips(chips, inner, "")
        // The label owns the first line's left margin; continuation lines line up
        // under the chips rather than under the label.
        return [fitLine(head + (first[0] ?? ""), inner), ...first.slice(1).map((l) => fitLine("    " + l, inner))]
      }
    }
  }

  private legend(row: FormRow | undefined, action: string): string {
    const parts: string[] = []
    const extra = this.opts.extraHint?.()
    if (extra) parts.push(extra)
    if (row?.kind === "cycle") {
      parts.push("←→ cycle")
      if (row.enter) parts.push(row.enterHint ?? "⏎ pick")
    }
    if (row?.kind === "chips") parts.push("←→ chip", "space toggle")
    parts.push("↑↓ field")
    if (!(row?.kind === "cycle" && row.enter)) parts.push(row?.kind === "action" ? `⏎ ${action}` : "⏎ next")
    parts.push(this.opts.cancelHint ?? "esc cancel")
    return parts.join(" · ")
  }

  render(width: number): string[] {
    const rows = this.opts.rows()
    const inner = width - 4
    const focus = this.current(rows)
    const groups = rows.map((r, i) => this.renderRow(r, i === focus, inner))
    const budget = formBudget(this.rows(), this.error !== null)
    const shapes = groups.map((lines, i) => ({ lines: lines.length, focusable: rows[i]!.kind !== "note" }))
    const focusIndex = focus >= 0 ? focus : 0
    const { start, end } = windowRows(shapes, focusIndex, budget)
    const clipped = start > 0 || end < groups.length

    const body: string[] = []
    if (clipped) body.push(moreMarker(start > 0, "▲"))
    for (let i = start; i < end; i++) body.push(...groups[i]!)
    if (clipped) body.push(moreMarker(end < groups.length, "▼"))
    if (this.error) body.push(fitLine(chalk.red(this.error), inner))

    const action = rows.find((r): r is ActionRow => r.kind === "action")
    return frame(
      {
        title: this.opts.title(),
        body,
        hint: this.legend(focus >= 0 ? rows[focus] : undefined, action ? action.label().toLowerCase() : "submit"),
        color: this.opts.color,
      },
      width,
    )
  }
}
