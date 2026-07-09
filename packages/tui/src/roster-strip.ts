import chalk, { type ChalkInstance } from "chalk"
import type { RosterItem } from "@pipeline-moe/client-core"

/**
 * The roster as a horizontal timeline strip (Dofus-style turn bar) under the
 * room tabs — one row of colored cells instead of a 26-column sidebar. The
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

/** Approximate printed width — emoji icons occupy 2 columns but count 2 in
 *  .length already (surrogate pair), except BMP ones which count 1; add one
 *  slack column per cell instead of a full wcwidth dependency. */
function printedWidth(text: string): number {
  return text.length + 1
}

/** Build the strip cells at the widest tier that fits: names (+ ctx% when
 *  hot) → icons only. Cells are joined by " │ " (3 cols) with 2 cols of
 *  outer padding accounted for. */
export function stripCells(roster: RosterItem[], runningId: string | null, width: number): StripCell[] {
  const build = (tier: "name" | "icon") =>
    roster.map((r) => ({
      id: r.id,
      text: cellText(r, tier),
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

/** Paint the cells into ONE flat ANSI string for a single <Text> — same idiom
 *  as the Transcript's pre-rendered markdown lines: one string, one yoga node,
 *  wrap="truncate-end" owns the width. Keeps the strip's height provably one
 *  row (the layout reserves exactly 1 for it) without trusting how Ink
 *  measures a tree of nested colored <Text> cells. */
export function renderStrip(cells: StripCell[]): string {
  return cells
    .map((c) => {
      let paint: ChalkInstance = c.color.startsWith("#")
        ? chalk.hex(c.color)
        : ((chalk as unknown as Record<string, ChalkInstance>)[c.color] ?? chalk)
      if (c.dim) paint = paint.dim
      if (c.running) paint = paint.inverse.bold
      return paint(c.running ? ` ${c.text} ` : c.text)
    })
    .join(chalk.dim(" │ "))
}
