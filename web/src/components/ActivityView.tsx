import { useState } from "react"
import type { ToolActivity } from "../types"

const TOOL_ICON: Record<string, string> = {
  bash: "⌘",
  read: "📖",
  write: "✎",
  edit: "✏️",
  grep: "🔍",
  find: "📁",
  ls: "📂",
}

/** How many trailing calls the live (streaming) block shows. */
const LIVE_WINDOW = 3

/** One-line summary of a tool's args: the command, path, or pattern it acted on. */
function summarizeArgs(a: ToolActivity): string {
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

interface Props {
  activity: ToolActivity[]
  /** Live = an in-progress turn: open by default so the user watches it work. */
  live?: boolean
}

export function ActivityView({ activity, live }: Props) {
  const [showAll, setShowAll] = useState(false)
  if (activity.length === 0) return null
  const running = live && activity.some((a) => a.status === "running")
  const errors = activity.filter((a) => a.status === "error").length
  // Live window: a long turn racks up 100+ calls and floods the card, so the
  // streaming block shows only the trailing LIVE_WINDOW — with two guarantees:
  // the summary carries the full count, and an error can never scroll out of
  // sight (older errors stay pinned above the window).
  const windowed = live && !showAll && activity.length > LIVE_WINDOW
  const tail = windowed ? activity.slice(-LIVE_WINDOW) : activity
  const pinnedErrors = windowed ? activity.slice(0, -LIVE_WINDOW).filter((a) => a.status === "error") : []
  const hidden = activity.length - tail.length - pinnedErrors.length
  const item = (a: ToolActivity) => (
    <div key={a.toolCallId} className={`activity-item status-${a.status}`}>
      <div className="activity-line">
        <span className="activity-tool">
          <span className="activity-icon">{TOOL_ICON[a.toolName] ?? "🔧"}</span>
          {a.toolName}
        </span>
        <code className="activity-args">{summarizeArgs(a)}</code>
        <span className={`activity-badge badge-${a.status}`}>
          {a.status === "running" ? "…" : a.status === "error" ? "err" : "ok"}
        </span>
      </div>
      {a.result ? (
        <details className="activity-result">
          <summary>result</summary>
          <pre>{a.result}</pre>
        </details>
      ) : null}
    </div>
  )
  return (
    <details className="activity" open={live}>
      <summary className="activity-summary">
        🔧 {activity.length} tool {activity.length === 1 ? "call" : "calls"}
        {errors ? <span className="activity-errors"> · {errors} ✗</span> : null}
        {running ? " · running…" : ""}
      </summary>
      <div className="activity-list">
        {pinnedErrors.map(item)}
        {hidden > 0 ? (
          <button type="button" className="activity-earlier" onClick={() => setShowAll(true)}>
            ▸ {hidden} earlier call{hidden === 1 ? "" : "s"}
          </button>
        ) : null}
        {tail.map(item)}
      </div>
    </details>
  )
}
