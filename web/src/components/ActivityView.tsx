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
  if (activity.length === 0) return null
  const running = live && activity.some((a) => a.status === "running")
  return (
    <details className="activity" open={live}>
      <summary className="activity-summary">
        🔧 {activity.length} tool {activity.length === 1 ? "call" : "calls"}
        {running ? " · running…" : ""}
      </summary>
      <div className="activity-list">
        {activity.map((a) => (
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
        ))}
      </div>
    </details>
  )
}
