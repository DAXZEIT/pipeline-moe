// Turning a turn's chronological `parts` into display segments
// (docs/interleaved-turns.md, block 3 for the TUI, block 5 for the web).
//
// `parts` says WHAT happened in WHAT order; a tool part is a pointer into the
// entry's `activity`. Resolving those pointers and aggregating runs of tool
// calls is protocol work, not layout work: both clients need the same segment
// list, in the same order, with the same aggregation rule — only the drawing
// differs. It lives here so the two can never drift.
//
// What stays in each client: the TUI's line-budget windowing (a terminal has a
// fixed height; a scrolling page does not) and every ANSI/DOM decision.

import type { ToolActivity, TurnPart } from "./types.js"

export const TOOL_ICON: Record<string, string> = {
  bash: "⌘",
  read: "📖",
  write: "✎",
  edit: "✏️",
  grep: "🔍",
  find: "📁",
  ls: "📂",
}

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

/** One drawable unit of an interleaved turn. */
export type DisplaySegment =
  | { kind: "reasoning" | "text"; content: string }
  | { kind: "tools"; group: ActivityGroup }

/** Resolve tool pointers and aggregate runs of them, preserving order.
 *
 *  Aggregation never reaches across a thought or a paragraph of prose: two
 *  reads with a thought between them are two moments, not one ×2 burst.
 *
 *  A tool part whose id is not in `activity` is dropped rather than drawn as a
 *  placeholder: it can only happen if the two fields disagree, and an invented
 *  row would be a worse lie than a missing one. */
export function toSegments(parts: readonly TurnPart[], activity: ToolActivity[] | undefined): DisplaySegment[] {
  const byId = new Map((activity ?? []).map((a) => [a.toolCallId, a]))
  const segments: DisplaySegment[] = []
  let run: ToolActivity[] = []

  const flushRun = () => {
    if (run.length === 0) return
    for (const group of groupActivity(run)) segments.push({ kind: "tools", group })
    run = []
  }

  for (const part of parts) {
    if (part.type === "tool") {
      const act = byId.get(part.toolCallId)
      if (act) run.push(act)
      continue
    }
    flushRun()
    const content = part.content.trim()
    // Live segments are not trimmed at the source (a trailing space may still
    // be followed by more text), so an empty one is normal mid-stream.
    if (content) segments.push({ kind: part.type, content })
  }
  flushRun()
  return segments
}
