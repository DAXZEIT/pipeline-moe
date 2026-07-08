import type { RoomTask, RosterItem } from "../types"

interface Props {
  tasks: RoomTask[]
  roster: RosterItem[]
}

const ORDER: Record<RoomTask["status"], number> = { in_progress: 0, pending: 1, completed: 2 }

/** The shared task board — the agents' live decomposition of the current work.
 *  Read-only: agents maintain it via their task_* tools; the user steers by
 *  talking to them. Hidden while the board is empty. */
export function TasksPanel({ tasks, roster }: Props) {
  if (tasks.length === 0) return null
  const done = tasks.filter((t) => t.status === "completed").length
  const sorted = [...tasks].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.id - b.id)
  const ownerColor = (id?: string) => roster.find((r) => r.id === id)?.color

  return (
    <div className="tasks-panel">
      <h3>
        Tasks <span className="tasks-count">{done}/{tasks.length}</span>
      </h3>
      <ul className="tasks-list">
        {sorted.map((t) => (
          <li key={t.id} className={`task-row ${t.status}`} title={`#${t.id} — created by @${t.createdBy}`}>
            <span className="task-glyph">
              {t.status === "completed" ? "✔" : t.status === "in_progress" ? "▶" : "☐"}
            </span>
            <span className="task-subject">{t.subject}</span>
            {t.owner ? (
              <span className="task-owner" style={{ color: ownerColor(t.owner) ?? "var(--muted)" }}>
                @{t.owner}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
