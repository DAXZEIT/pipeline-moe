import chalk, { type ChalkInstance } from "chalk"
import stringWidth from "string-width"
import type { RosterItem } from "@pipeline-moe/client-core"
import { prettyModel } from "./model-name"

/**
 * The roster as a horizontal timeline strip (Dofus-style turn bar) under the
 * room tabs — one row of colored cells instead of a 26-column sidebar, plus a
 * model row underneath ("Opus 4.8", "M3") when any agent pins one. The
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
  text: string
  /** Model row text under the cell (name tier, when any agent pins a model):
   *  the pretty model name, or "default" for agents on the room default.
   *  Truncated to the cell's width at render time so it never widens it. */
  sub?: string
  /** Agent color; the running agent renders inverse in it (the timeline's
   *  "current turn" highlight), paused agents render gray+dim. */
  color: string
  running: boolean
  dim: boolean
  /** Context window above 80% — the cell's % suffix renders yellow. */
  warn: boolean
}

function cellText(r: RosterItem, tier: "name" | "icon"): string {
  const glyph = STATUS_GLYPH[r.status]
  const vision = r.vision === false ? "🚫" : ""
  if (tier === "icon") return `${glyph} ${r.icon}${vision}`
  const pct = r.contextUsage?.percent
  const ctx = pct != null && pct >= 80 ? ` ${Math.round(pct)}%` : ""
  return `${glyph} ${r.icon}${vision} ${r.name}${ctx}`
}

/** Printed width with one slack column per cell — string-width and the
 *  terminal can disagree by one on some emoji, and dropping a tier early
 *  beats truncating the last cell. */
function printedWidth(text: string): number {
  return stringWidth(text) + 1
}

/** Build the strip cells at the widest tier that fits: names (+ ctx% when
 *  hot) → icons only. Cells are joined by " │ " (3 cols) with 2 cols of
 *  outer padding accounted for. The model row exists only at name tier and
 *  never affects the fit (subs truncate to their cell's width). */
export function stripCells(roster: RosterItem[], runningId: string | null, width: number): StripCell[] {
  const anyModel = roster.some((r) => r.model)
  const build = (tier: "name" | "icon") =>
    roster.map((r) => ({
      id: r.id,
      text: cellText(r, tier),
      ...(tier === "name" && anyModel ? { sub: r.model ? prettyModel(r.model) : "default" } : {}),
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
export function stripRowCount(roster: RosterItem[], width: number): number {
  if (roster.length === 0) return 0
  return stripCells(roster, null, width).some((c) => c.sub !== undefined) ? 2 : 1
}

function paintFor(c: StripCell): ChalkInstance {
  let paint: ChalkInstance = c.color.startsWith("#")
    ? chalk.hex(c.color)
    : ((chalk as unknown as Record<string, ChalkInstance>)[c.color] ?? chalk)
  if (c.dim) paint = paint.dim
  return paint
}

/** Cut a plain string to `width` printed columns, "…"-terminated. */
function truncToWidth(text: string, width: number): string {
  if (stringWidth(text) <= width) return text
  let out = ""
  for (const ch of text) {
    if (stringWidth(out + ch) > width - 1) break
    out += ch
  }
  return out + "…"
}

/** Paint the cells into flat ANSI strings (one per row) for single <Text>s —
 *  same idiom as the Transcript's pre-rendered markdown lines: one string,
 *  one yoga node, wrap="truncate-end" owns the width. Keeps the strip's
 *  height provably rowCount rows without trusting how Ink measures a tree of
 *  nested colored <Text> cells. The model row pads every sub to its cell's
 *  exact printed width so the " │ " gutters line up across both rows. */
export function renderStrip(cells: StripCell[]): string[] {
  const top = cells
    .map((c) => {
      let paint = paintFor(c)
      if (c.running) paint = paint.inverse.bold
      return paint(c.running ? ` ${c.text} ` : c.text)
    })
    .join(chalk.dim(" │ "))
  if (!cells.some((c) => c.sub !== undefined)) return [top]
  const sub = cells
    .map((c) => {
      const w = stringWidth(c.text) + (c.running ? 2 : 0)
      const t = truncToWidth(c.sub ?? "", w)
      return paintFor(c).dim(t + " ".repeat(Math.max(0, w - stringWidth(t))))
    })
    .join(chalk.dim(" │ "))
  return [top, sub]
}
