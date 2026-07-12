import chalk, { type ChalkInstance } from "chalk"
import stringWidth from "string-width"
import type { RosterItem } from "@pipeline-moe/client-core"
import { prettyModel } from "./model-name"
import { fmt } from "./roster-stats"

/**
 * The roster as a horizontal timeline strip (Dofus-style turn bar) under the
 * room tabs — one row of colored cells instead of a 26-column sidebar, plus a
 * model row ("Opus 4.8", "M3" — the resolved room default when not pinned)
 * and a context-usage row ("220K/1000K", yellow when hot) underneath. The
 * transcript gets the full terminal width back; per-agent detail and actions
 * live in Ctrl+R. Pure cell-building here so the layout is testable without
 * rendering Ink.
 */

export const STATUS_GLYPH: Record<RosterItem["status"], string> = {
  idle: "○",
  active: "●",
  thinking: "◐",
  working: "◑",
  compacting: "◒",
  retrying: "↻",
}

export type StripCell = {
  id: string
  /** Fused seats: seat id when this agent shares a context. Adjacent cells of
   *  the same seat render as ONE group — fused separator, a single spanning
   *  model/usage entry (two identical gauges would be lying by redundancy). */
  seat?: string
  text: string
  /** Model row text under the cell (name tier): the agent's pinned model or
   *  the room default, prettified — "default" only when the server doesn't
   *  say what the default resolves to. Truncated to the cell's width at
   *  render time so it never widens it. */
  sub?: string
  /** Context-usage row text ("220K/1000K"), name tier when the data exists. */
  use?: string
  /** Agent color; the running agent renders inverse in it (the timeline's
   *  "current turn" highlight), paused agents render gray+dim. */
  color: string
  running: boolean
  dim: boolean
  /** Context window above 80% — the usage row renders yellow. */
  warn: boolean
}

function cellText(r: RosterItem, tier: "name" | "icon", hasUsageRow: boolean): string {
  const glyph = STATUS_GLYPH[r.status]
  const vision = r.vision === false ? "🚫" : ""
  if (tier === "icon") return `${glyph} ${r.icon}${vision}`
  // Without a usage row the hot-context alarm lives in the cell itself.
  const pct = r.contextUsage?.percent
  const ctx = !hasUsageRow && pct != null && pct >= 80 ? ` ${Math.round(pct)}%` : ""
  return `${glyph} ${r.icon}${vision} ${r.name}${ctx}`
}

function usageText(r: RosterItem): string | undefined {
  const ctx = r.contextUsage
  if (!ctx) return undefined
  return `${ctx.tokens != null ? fmt(ctx.tokens) : "—"}/${fmt(ctx.contextWindow)}`
}

/** Printed width with one slack column per cell — string-width and the
 *  terminal can disagree by one on some emoji, and dropping a tier early
 *  beats truncating the last cell. */
function printedWidth(text: string): number {
  return stringWidth(text) + 1
}

/** Build the strip cells at the widest tier that fits: names → icons only.
 *  Cells are joined by " │ " (3 cols) with 2 cols of outer padding accounted
 *  for. The model and usage rows exist only at name tier and never affect
 *  the fit (they truncate to their cell's width). */
export function stripCells(
  roster: RosterItem[],
  runningId: string | null,
  width: number,
  defaultModel?: string | null,
): StripCell[] {
  const modelRow = roster.some((r) => r.model) || !!defaultModel
  const usageRow = roster.some((r) => r.contextUsage)
  const build = (tier: "name" | "icon") =>
    roster.map((r) => ({
      id: r.id,
      ...(r.seat ? { seat: r.seat } : {}),
      text: cellText(r, tier, tier === "name" && usageRow),
      ...(tier === "name" && modelRow
        ? { sub: r.model ? prettyModel(r.model) : defaultModel ? prettyModel(defaultModel) : "default" }
        : {}),
      ...(tier === "name" && usageRow ? { use: usageText(r) ?? "—" } : {}),
      color: r.active ? r.color : "gray",
      running: r.id === runningId,
      dim: !r.active,
      warn: (r.contextUsage?.percent ?? 0) >= 80,
    }))
  const fits = (cells: StripCell[]) =>
    cells.reduce((n, c) => n + printedWidth(c.text), 0) + (cells.length - 1) * 3 + 2 <= width
  const named = build("name")
  if (fits(named)) return named
  return build("icon")
}

/** Rows the strip occupies at this width — App must reserve exactly this many
 *  in the transcript's height budget. */
export function stripRowCount(roster: RosterItem[], width: number, defaultModel?: string | null): number {
  if (roster.length === 0) return 0
  const cells = stripCells(roster, null, width, defaultModel)
  return 1 + (cells.some((c) => c.sub !== undefined) ? 1 : 0) + (cells.some((c) => c.use !== undefined) ? 1 : 0)
}

function paintFor(c: StripCell): ChalkInstance {
  let paint: ChalkInstance = c.color.startsWith("#")
    ? chalk.hex(c.color)
    : ((chalk as unknown as Record<string, ChalkInstance>)[c.color] ?? chalk)
  if (c.dim) paint = paint.dim
  return paint
}

/** Cut a plain string to `width` printed columns, "…"-terminated. Backs up to
 *  the last word boundary when that keeps at least half the width — "Qwopus3.6…"
 *  reads better than "Qwopus3.6 2…". */
function truncToWidth(text: string, width: number): string {
  if (stringWidth(text) <= width) return text
  let out = ""
  for (const ch of text) {
    if (stringWidth(out + ch) > width - 1) break
    out += ch
  }
  const sp = out.lastIndexOf(" ")
  if (sp >= Math.floor((width - 1) / 2)) out = out.slice(0, sp)
  return out + "…"
}

/** Adjacent cells sharing a fused seat, grouped. Non-adjacent same-seat cells
 *  fall into separate runs (the strip honors roster order — presets that fuse
 *  keep their hats adjacent naturally). */
type SeatRun = { cells: StripCell[]; seat?: string }

function runsOf(cells: StripCell[]): SeatRun[] {
  const runs: SeatRun[] = []
  for (const c of cells) {
    const last = runs[runs.length - 1]
    if (last && last.seat !== undefined && c.seat === last.seat) last.cells.push(c)
    else runs.push({ cells: [c], seat: c.seat })
  }
  return runs
}

/** Paint the cells into flat ANSI strings (one per row) for single <Text>s —
 *  same idiom as the Transcript's pre-rendered markdown lines: one string,
 *  one yoga node, wrap="truncate-end" owns the width. Keeps the strip's
 *  height provably its row count without trusting how Ink measures a tree of
 *  nested colored <Text> cells. Under-rows pad every entry to its cell's
 *  exact printed width so the " │ " gutters line up across all rows.
 *  Fused seats: hats of one seat join with a fused "┈" gutter instead of the
 *  "│" wall, and their model/usage under-entries SPAN the whole group — one
 *  seat, one context, one gauge (labeled "⌐<seat>"). */
export function renderStrip(cells: StripCell[]): string[] {
  const sep = chalk.dim(" │ ")
  const fusedSep = chalk.dim(" ┈ ")
  const cellWidth = (c: StripCell) => stringWidth(c.text) + (c.running ? 2 : 0)
  const runs = runsOf(cells)
  const runWidth = (r: SeatRun) => r.cells.reduce((n, c) => n + cellWidth(c), 0) + (r.cells.length - 1) * 3
  const pad = (paint: ChalkInstance, text: string, width: number) => {
    const t = truncToWidth(text, width)
    return paint(t + " ".repeat(Math.max(0, width - stringWidth(t))))
  }
  const underRow = (text: (c: StripCell) => string | undefined, paint: (c: StripCell) => ChalkInstance) =>
    runs
      .map((r) => {
        if (r.cells.length === 1) return pad(paint(r.cells[0]), text(r.cells[0]) ?? "", cellWidth(r.cells[0]))
        // Spanning entry for the fused group — first cell carrying data wins
        // (the values cannot differ: same session behind every hat).
        const first = r.cells.find((c) => text(c) !== undefined) ?? r.cells[0]
        const label = r.seat ? `⌐${r.seat}: ` : ""
        return pad(paint(first), `${label}${text(first) ?? ""}`, runWidth(r))
      })
      .join(sep)

  const rows = [
    runs
      .map((r) =>
        r.cells
          .map((c) => {
            let paint = paintFor(c)
            if (c.running) paint = paint.inverse.bold
            return paint(c.running ? ` ${c.text} ` : c.text)
          })
          .join(fusedSep),
      )
      .join(sep),
  ]
  if (cells.some((c) => c.sub !== undefined)) rows.push(underRow((c) => c.sub, (c) => paintFor(c).dim))
  if (cells.some((c) => c.use !== undefined))
    rows.push(underRow((c) => c.use, (c) => (c.warn ? chalk.yellow : paintFor(c).dim)))
  return rows
}
