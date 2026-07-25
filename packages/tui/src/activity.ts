import { groupActivity, summarizeArgs, toolDuration, TOOL_ICON, type ActivityGroup } from "@pipeline-moe/client-core"

// The tool vocabulary (icons, arg summary) and the ×N aggregation rule are
// shared with the web renderer — they live in client-core so the two clients
// cannot describe the same turn differently. Re-exported here because every
// TUI module already reaches for them through this file.
export { groupActivity, summarizeArgs, TOOL_ICON }
export type { ActivityGroup }

/** Status badge text and color. */
export function statusBadge(status: string): { text: string; color: string } {
  switch (status) {
    case "ok": return { text: "ok", color: "green" }
    case "error": return { text: "err", color: "red" }
    default: return { text: "…", color: "yellow" }
  }
}

// ── Live activity window ──────────────────────────────────────────────────
//
// A long turn can rack up 100+ tool calls; rendering them all in the live
// block floods the transcript (same problem the thought block solves with
// slice(-2)). The live view aggregates ×N bursts, then shows only the last
// LIVE_WINDOW groups — with two guarantees: the header always carries the
// full count, and an error can never scroll out of sight.

/** How many trailing activity groups the live (streaming) block shows. */
export const LIVE_WINDOW = 3

/** Slice the live window: the last `size` groups, plus any error groups that
 *  already scrolled past it (pinned — errors are the one thing the user scans
 *  for, truncation must never hide them). `hiddenCalls` counts the individual
 *  calls that are neither visible nor pinned. */
export function windowActivity(groups: ActivityGroup[], size = LIVE_WINDOW): {
  pinnedErrors: ActivityGroup[]
  visible: ActivityGroup[]
  hiddenCalls: number
} {
  const older = groups.slice(0, Math.max(0, groups.length - size))
  const pinnedErrors = older.filter((g) => g.status === "error")
  const hiddenCalls = older.filter((g) => g.status !== "error").reduce((n, g) => n + g.items.length, 0)
  return { pinnedErrors, visible: groups.slice(-size), hiddenCalls }
}

/** One display line for a group: a single call keeps the classic format, a
 *  ×N group comma-joins its args ("📖 read ×6 planner.md, builder.md, …").
 *
 *  A trailing duration appears only when the call (or the whole burst) took
 *  long enough to be worth reading — see SLOW_TOOL_MS. It takes its width out
 *  of the args budget rather than out of the terminal's, so the line still
 *  fits. */
export function groupLine(g: ActivityGroup, argWidth: number): { text: string; color: string } {
  const icon = TOOL_ICON[g.toolName] ?? "🔧"
  const badge = statusBadge(g.status)
  const dur = toolDuration(g.items)
  const args = g.items.map(summarizeArgs).filter(Boolean).join(", ")
  const budget = Math.max(10, argWidth - (dur ? dur.length + 1 : 0))
  const truncated = args.length > budget ? args.slice(0, budget - 1) + "…" : args
  const count = g.items.length > 1 ? ` ×${g.items.length}` : ""
  const tail = `  ${badge.text}${dur ? ` ${dur}` : ""}`
  return { text: `  ${icon} ${g.toolName}${count}${truncated ? " " + truncated : ""}${tail}`, color: badge.color }
}
