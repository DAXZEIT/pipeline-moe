// The five generic overlays, as pi-tui components.
//
// These are REPLACED, not ported. Their logic already lived in framework-free
// modules (`preset-picker.ts`, `roster-menu.ts`, `seats-menu.ts`), which is why
// 509 lines of Ink JSX collapse to this: a list picker built on pi-tui's
// `SelectList`, a prompt built on its `Input`, and three that are string
// generation inside `overlay-frame.ts`'s box.
//
// WHAT CHANGES VISIBLY, AND WHY IT IS THE RIGHT TRADE
//
// `SelectList` windows, wraps the selection, prints an `(n/total)` counter and
// lays hints out in a fixed second column. Our Ink overlay printed `▲ more` /
// `▼ more` markers and pushed each hint to the right edge with
// `justifyContent="space-between"`. Taking the library's layout loses the
// markers and the ragged right edge; it gains code we no longer own. The three
// overlays that are NOT list pickers keep their own layout, because there is no
// library component to defer to and `twoColumn` already gives the right edge.
//
// Filtering is `fuzzyFilter` from pi-tui, not `SelectList.setFilter`: that one is
// a case-insensitive PREFIX match on `value` alone (select-list.js:25), which
// would filter on our opaque ids and miss every hint. `fuzzyFilter` matches all
// query characters in order across whatever text we hand it, and sorts by match
// quality — a superset of the `includes()` on `label + hint` we had.

import chalk from "chalk"
import { Input, SelectList, fuzzyFilter, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui"
import type { PresetFile, RoomStore, RoomTask, RosterItem } from "@pipeline-moe/client-core"
import type { SelectItem } from "../commands/types"
import { shortModel } from "../commands/registry"
import { presetPickerLayout, presetSummary, previewPersonas } from "../preset-picker"
import { fitLine, frame, moreMarker, twoColumn, windowStart } from "./overlay-frame"

/** Rows the terminal has. Components need it because a windowed list has to
 *  choose how many rows to show, and pi-tui hands `render` only a width — its
 *  `maxHeight` option TRUNCATES, which would cut the key legend off the bottom
 *  rather than shrink the list. */
export type Rows = () => number

const rowsOf: Rows = () => process.stdout.rows ?? 24

/** How many list rows fit, leaving the conversation visible behind the overlay
 *  and the legend inside it. */
function listRows(rows: number, max: number): number {
  return Math.max(3, Math.min(max, rows - 12))
}

const SELECT_THEME = {
  selectedPrefix: (s: string) => chalk.magenta(s),
  selectedText: (s: string) => chalk.magenta.inverse(s),
  description: (s: string) => chalk.dim(s),
  scrollInfo: (s: string) => chalk.dim(s),
  noMatch: (s: string) => chalk.dim(s),
}

/* ── 1. The list picker ─────────────────────────────────────────────────────
 *
 * Drives /resume, /template, /providers, /rooms, /model, /help, /preset load,
 * /roster and /seats — nine commands on one component, which is why it was worth
 * making generic in the first place.
 */
export interface SelectOverlayOptions {
  title: string
  items: SelectItem[]
  emptyText?: string
  onSelect: (id: string) => void
  onCancel: () => void
}

export class SelectOverlayComponent implements Component, Focusable {
  focused = false
  private query = ""
  private list: SelectList
  private builtFor = { query: "", rows: 0 }

  constructor(
    private opts: SelectOverlayOptions,
    private rows: Rows = rowsOf,
  ) {
    this.list = this.build()
  }

  private filtered(): SelectItem[] {
    if (!this.query) return this.opts.items
    return fuzzyFilter(this.opts.items, this.query, (it) => `${it.label} ${it.hint ?? ""}`)
  }

  /** `SelectList` fixes its item set and its window height at construction, so a
   *  new filter or a resize means a new list. Cheap — it holds two arrays — and
   *  it resets the cursor to the top, which is what our Ink version did on every
   *  filter change anyway. */
  private build(): SelectList {
    const rows = this.rows()
    this.builtFor = { query: this.query, rows }
    const list = new SelectList(
      this.filtered().map((it) => ({ value: it.id, label: it.label, description: it.hint })),
      listRows(rows, 12),
      SELECT_THEME,
    )
    list.onSelect = (item): void => this.opts.onSelect(item.value)
    return list
  }

  private sync(): void {
    if (this.builtFor.query !== this.query || this.builtFor.rows !== this.rows()) this.list = this.build()
  }

  invalidate(): void {
    this.list.invalidate()
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) return this.opts.onCancel()
    // A list with nothing to pick must never read as a stuck modal: any key
    // dismisses it. A filter with no match is different — that stays editable.
    if (this.opts.items.length === 0) return this.opts.onCancel()
    if (matchesKey(data, "backspace")) {
      if (this.query) this.query = this.query.slice(0, -1)
      return
    }
    // One printable character, no control sequence: the filter grows. Checked
    // before delegating so a plain letter can never reach the list's own keys.
    if (data.length === 1 && data >= " " && data !== "\x7f") {
      this.query += data
      return
    }
    this.sync()
    this.list.handleInput(data)
  }

  render(width: number): string[] {
    this.sync()
    const total = this.filtered().length
    const body =
      this.opts.items.length === 0
        ? [chalk.dim(this.opts.emptyText ?? "Nothing to show.")]
        : total === 0
          ? [chalk.dim(`No match for “${this.query}” — backspace to edit.`)]
          : this.list.render(width - 4)
    return frame(
      {
        title: this.opts.title,
        titleRight: this.query ? chalk.yellow(`🔎 ${this.query}`) : undefined,
        body,
        hint: "↑↓ select · ⏎ choose · type to filter · esc cancel",
        color: "magenta",
      },
      width,
    )
  }
}

/* ── 2. The one-line prompt ─────────────────────────────────────────────────── */

/** A one-line modal prompt. Editing is pi-tui's `Input` — word motions,
 *  kill-ring, undo, bracketed paste — instead of the 40 lines of key handling our
 *  Ink version carried.
 *
 *  MASKING is ours, and it costs the cursor. `Input` renders its own value and
 *  keeps its cursor private, so a masked field renders from `getValue()` with no
 *  cursor shown. That is a real difference from the Ink overlay, and an
 *  acceptable one: the field exists to paste an API key and check its last four
 *  characters, and a cursor position inside a run of bullets carries no
 *  information. Every edit still goes through `Input`. */
export class TextInputOverlayComponent implements Component, Focusable {
  private input = new Input()

  constructor(
    private opts: {
      title: string
      placeholder?: string
      mask?: boolean
      onSubmit: (value: string) => void
      onCancel: () => void
    },
  ) {
    this.input.onEscape = (): void => this.opts.onCancel()
    this.input.onSubmit = (v: string): void => {
      const t = v.trim()
      if (t) this.opts.onSubmit(t)
    }
  }

  // Focus has to reach the Input, or it never emits CURSOR_MARKER and the
  // hardware cursor (and with it the IME candidate window) sits in the wrong
  // place. The TUI sets `focused` on the component it focused — this one.
  get focused(): boolean {
    return this.input.focused
  }
  set focused(v: boolean) {
    this.input.focused = v
  }

  invalidate(): void {
    this.input.invalidate()
  }

  handleInput(data: string): void {
    this.input.handleInput(data)
  }

  render(width: number): string[] {
    const value = this.input.getValue()
    let body: string[]
    if (this.opts.mask) {
      const shown = value.length > 4 ? "•".repeat(value.length - 4) + value.slice(-4) : value
      body = [chalk.magenta("› ") + (shown || chalk.dim(this.opts.placeholder ?? ""))]
    } else if (!value) {
      body = [chalk.magenta("› ") + chalk.dim(this.opts.placeholder ?? "")]
    } else {
      body = this.input.render(width - 4)
    }
    return frame(
      {
        title: this.opts.title,
        body,
        hint: this.opts.mask ? "masked — only the last 4 shown · ⏎ submit · esc cancel" : "⏎ submit · esc cancel",
        color: "magenta",
      },
      width,
    )
  }
}

/* ── 3. The task board ──────────────────────────────────────────────────────── */

const TASK_ORDER: Record<RoomTask["status"], number> = { in_progress: 0, pending: 1, completed: 2 }

/** Read-only board (⌃P or /tasks). Read-only on purpose: the board belongs to the
 *  agents, and the user steers by talking to them. */
export class TasksOverlayComponent implements Component, Focusable {
  focused = false
  private offset = 0

  constructor(
    private opts: { tasks: () => RoomTask[]; roster: () => RosterItem[]; onClose: () => void },
    private rows: Rows = rowsOf,
  ) {}

  invalidate(): void {}

  private sorted(): RoomTask[] {
    return [...this.opts.tasks()].sort((a, b) => TASK_ORDER[a.status] - TASK_ORDER[b.status] || a.id - b.id)
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+p") || data === "q") return this.opts.onClose()
    const visible = listRows(this.rows(), 14)
    const maxOffset = Math.max(0, this.sorted().length - visible)
    if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1)
    else if (matchesKey(data, "down")) this.offset = Math.min(maxOffset, this.offset + 1)
  }

  render(width: number): string[] {
    const tasks = this.opts.tasks()
    const sorted = this.sorted()
    const done = tasks.filter((t) => t.status === "completed").length
    const inner = width - 4
    const visible = listRows(this.rows(), 14)
    const start = Math.min(this.offset, Math.max(0, sorted.length - visible))
    const colorOf = (id?: string): string | undefined => this.opts.roster().find((r) => r.id === id)?.color

    const body =
      tasks.length === 0
        ? [chalk.dim("No tasks — the planner creates them with task_create when dispatching work.")]
        : [
            moreMarker(start > 0, "▲"),
            ...sorted.slice(start, start + visible).map((t) => {
              const label =
                t.status === "completed"
                  ? chalk.dim.strikethrough(`✔ ${t.subject}`)
                  : t.status === "in_progress"
                    ? chalk.yellow.bold(`▶ ${t.subject}`)
                    : `☐ ${t.subject}`
              const owner = t.owner
                ? (colorOf(t.owner) ? chalk.hex(colorOf(t.owner)!) : chalk.dim)(`@${t.owner}`)
                : ""
              return twoColumn(label, owner, inner)
            }),
            moreMarker(start + visible < sorted.length, "▼"),
          ]

    return frame(
      {
        title: `TASK BOARD ${done}/${tasks.length} done`,
        body,
        hint: "↑↓ scroll · esc / ⌃P close",
        color: "cyan",
      },
      width,
    )
  }
}

/* ── 4. The line-up editor ──────────────────────────────────────────────────── */

/** Interactive roster editor (/lineup). Reads the roster from the store on every
 *  render, so reorder / pause / kick reflect server confirmations as they arrive
 *  — the mutations are all existing store actions and this is pure UX. */
export class LineupOverlayComponent implements Component, Focusable {
  focused = false
  private cursor = 0

  constructor(
    private opts: { store: RoomStore; onAddAgent: () => void; onClose: () => void },
  ) {}

  invalidate(): void {}

  private roster(): RosterItem[] {
    return this.opts.store.getSnapshot().roster
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) return this.opts.onClose()
    if (data === "a") return this.opts.onAddAgent()
    const roster = this.roster()
    if (roster.length === 0) return
    const i = Math.min(this.cursor, roster.length - 1)
    const cur = roster[i]!
    const { actions } = this.opts.store
    if (matchesKey(data, "up")) this.cursor = Math.max(0, i - 1)
    else if (matchesKey(data, "down")) this.cursor = Math.min(roster.length - 1, i + 1)
    else if (data === "[" || data === "]") {
      const j = i + (data === "[" ? -1 : 1)
      if (j < 0 || j >= roster.length) return
      const order = roster.map((p) => p.id)
      ;[order[i], order[j]] = [order[j]!, order[i]!]
      actions.reorderParticipants(order)
      this.cursor = j
    } else if (data === " ") actions.setActive(cur.id, !cur.active)
    else if (data === "p") actions.setParallel(cur.id, !cur.parallel)
    else if (data === "x") actions.kick(cur.id)
  }

  render(width: number): string[] {
    const roster = this.roster()
    const inner = width - 4
    const i = Math.min(this.cursor, Math.max(0, roster.length - 1))
    const body =
      roster.length === 0
        ? [chalk.dim("Empty room — press a to add an agent.")]
        : roster.map((p, idx) => {
            const name = chalk.hex(p.color)(`${p.icon} ${p.name}`)
            const state = `${p.active ? "●active" : "○paused"}${p.parallel ? " ∥" : ""}`
            const left = idx === i ? chalk.cyan.inverse(`▶ ${p.icon} ${p.name}  ${state}`) : `  ${name}  ${state}`
            return twoColumn(left, chalk.dim(shortModel(p.model) ?? "room default"), inner)
          })
    return frame(
      {
        title: `Line-up (${roster.length})`,
        body,
        hint: "↑↓ cursor · [ ] reorder · space pause · p parallel · x kick · a add · esc done",
        color: "cyan",
      },
      width,
    )
  }
}

/* ── 5. The preset picker ───────────────────────────────────────────────────── */

/** List AND a live preview of the highlighted preset's agents, in one overlay —
 *  ↑/↓ moves the preview with the cursor, there is no "open detail" step. The
 *  list always ends with a virtual "＋ new" row, so /preset alone is a complete
 *  entry point even before any preset exists.
 *
 *  No typing-to-filter here, unlike the list picker: a bare `a` is the apply
 *  shortcut, and a filter mode would need a second key just to disambiguate it
 *  from the start of a query. Preset lists stay short in practice. */
export class PresetPickerOverlayComponent implements Component, Focusable {
  focused = false
  private index = 0

  constructor(
    private opts: {
      presets: PresetFile[]
      store: RoomStore
      onCancel: () => void
      onCompose?: (preset: PresetFile, isNew: boolean) => void
    },
    private rows: Rows = rowsOf,
  ) {}

  invalidate(): void {}

  /** The virtual "＋ new" row lives past the end of `presets`. */
  private total(): number {
    return this.opts.presets.length + 1
  }

  handleInput(data: string): void {
    const total = this.total()
    const cursor = Math.min(this.index, total - 1)
    const current = this.opts.presets[cursor]
    const onNewRow = cursor === this.opts.presets.length
    const { store } = this.opts

    if (matchesKey(data, "escape")) return this.opts.onCancel()
    if (matchesKey(data, "up")) {
      this.index = (cursor - 1 + total) % total
      return
    }
    if (matchesKey(data, "down")) {
      this.index = (cursor + 1) % total
      return
    }
    if (matchesKey(data, "enter")) {
      if (onNewRow) {
        this.opts.onCompose?.({ name: "", personas: [] }, true)
        return
      }
      if (!current) return
      this.opts.onCancel()
      store.actions
        .loadPreset(current.name)
        .then(() => store.pushNotice(`Loaded preset "${current.name}" — new discussion.`))
        .catch(() => {})
      return
    }
    if (data === "a") {
      if (!current) return
      this.opts.onCancel()
      store.actions
        .applyPreset(current.name)
        .then(() => store.pushNotice(`Applied preset "${current.name}" — roster swapped, transcript kept.`))
        .catch(() => {})
      return
    }
    if (data === "n" && current) this.opts.onCompose?.(current, false)
  }

  render(width: number): string[] {
    const { presets } = this.opts
    const inner = width - 4
    const total = this.total()
    const cursor = Math.min(this.index, total - 1)
    const current = presets[cursor]
    const onNewRow = cursor === presets.length
    const { listVisible, previewMax } = presetPickerLayout(this.rows(), total)
    const start = windowStart(cursor, total, listVisible)
    const end = start + listVisible
    const { shown, hidden } = previewPersonas(current, previewMax)

    const rows: string[] = [moreMarker(start > 0, "▲")]
    for (const [i, p] of presets.slice(start, Math.min(end, presets.length)).entries()) {
      const real = start + i
      const left = real === cursor ? chalk.magenta.inverse(`▶ ${p.name}`) : `  ${p.name}`
      rows.push(twoColumn(left, chalk.dim(presetSummary(p)), inner))
    }
    if (end > presets.length) {
      const left = onNewRow ? chalk.magenta.inverse("▶ ＋ new") : chalk.green("  ＋ new")
      rows.push(twoColumn(left, chalk.dim("compose a team from scratch"), inner))
    }
    rows.push(moreMarker(end < total, "▼"), " ")

    if (onNewRow) {
      rows.push(chalk.dim("Opens the composer on an empty roster — a add member, s save."))
    } else {
      for (const p of shown) {
        const tools = p.tools.length ? chalk.dim("  " + p.tools.join(" ")) : ""
        rows.push(
          fitLine(chalk.hex(p.color)(`${p.icon} ${p.name}`) + "  " + chalk.cyan(shortModel(p.model) ?? "default") + tools, inner),
        )
      }
      if (hidden > 0) rows.push(chalk.dim(`  … +${hidden} more agents`))
    }

    return frame(
      {
        title: "Presets",
        titleRight: total > listVisible ? `${cursor + 1}/${total}` : undefined,
        body: rows,
        hint: onNewRow ? "⏎ compose · ↑↓ select · esc cancel" : "⏎ load · a apply · n remix · ↑↓ select · esc cancel",
        color: "magenta",
      },
      width,
    )
  }
}
