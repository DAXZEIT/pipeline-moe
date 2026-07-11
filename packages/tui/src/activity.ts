import type { ToolActivity } from "@pipeline-moe/client-core"

/** One-line summary of a tool's args: the command, path, or pattern it acted on. */
export function summarizeArgs(a: ToolActivity): string {
  const args = a.args as Record<string, unknown> | undefined
  if (!args || typeof args !== "object") return ""
  for (const key of ["command", "file_path", "path", "pattern"]) {
    const v = args[key]
    if (typeof v === "string") return v
  }
  try {
    return JSON.stringify(args)
  } catch {
    return ""
  }
}

export const TOOL_ICON: Record<string, string> = {
  bash: "⌘",
  read: "📖",
  write: "✎",
  edit: "✏️",
  grep: "🔍",
  find: "📁",
  ls: "📂",
}

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

export interface ActivityGroup {
  toolName: string
  items: ToolActivity[]
  /** Only ok calls aggregate, so a non-ok group is always a single call. */
  status: ToolActivity["status"]
}

/** Collapse consecutive same-tool ok calls into one ×N group ("read ×6").
 *  Errors and the running call never merge — each must stay individually
 *  visible. */
export function groupActivity(activity: ToolActivity[]): ActivityGroup[] {
  const groups: ActivityGroup[] = []
  for (const a of activity) {
    const last = groups[groups.length - 1]
    if (a.status === "ok" && last?.status === "ok" && last.toolName === a.toolName) last.items.push(a)
    else groups.push({ toolName: a.toolName, items: [a], status: a.status })
  }
  return groups
}

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
 *  ×N group comma-joins its args ("📖 read ×6 planner.md, builder.md, …"). */
export function groupLine(g: ActivityGroup, argWidth: number): { text: string; color: string } {
  const icon = TOOL_ICON[g.toolName] ?? "🔧"
  const badge = statusBadge(g.status)
  const args = g.items.map(summarizeArgs).filter(Boolean).join(", ")
  const truncated = args.length > argWidth ? args.slice(0, argWidth - 1) + "…" : args
  const count = g.items.length > 1 ? ` ×${g.items.length}` : ""
  return { text: `  ${icon} ${g.toolName}${count}${truncated ? " " + truncated : ""}  ${badge.text}`, color: badge.color }
}
