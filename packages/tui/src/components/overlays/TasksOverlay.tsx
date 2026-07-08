import { Box, Text, useInput } from "ink"
import { useTerminalSize } from "../../useTerminalSize"
import { useState } from "react"
import type { RoomTask, RosterItem } from "@pipeline-moe/client-core"

const ORDER: Record<RoomTask["status"], number> = { in_progress: 0, pending: 1, completed: 2 }

/** Full task-board view (Ctrl+P / /tasks). Read-only — the board belongs to
 *  the agents; the user steers by talking to them. In-progress first, then
 *  pending, completed struck through at the bottom, windowed like
 *  SelectOverlay so a long board never pushes the chrome off-screen. */
export function TasksOverlay({
  tasks,
  roster,
  onClose,
  isActive,
}: {
  tasks: RoomTask[]
  roster: RosterItem[]
  onClose: () => void
  isActive: boolean
}) {
  const [offset, setOffset] = useState(0)
  const { rows } = useTerminalSize()

  const sorted = [...tasks].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.id - b.id)
  const done = tasks.filter((t) => t.status === "completed").length

  const maxVisible = Math.max(3, Math.min(14, rows - 10))
  const maxOffset = Math.max(0, sorted.length - maxVisible)
  const start = Math.min(offset, maxOffset)
  const windowItems = sorted.slice(start, start + maxVisible)

  useInput(
    (input, key) => {
      if (key.escape || (key.ctrl && input === "p") || input === "q") return onClose()
      if (key.upArrow) return setOffset((o) => Math.max(0, o - 1))
      if (key.downArrow) return setOffset((o) => Math.min(maxOffset, o + 1))
    },
    { isActive },
  )

  const ownerColor = (id?: string) => roster.find((r) => r.id === id)?.color

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        TASK BOARD {done}/{tasks.length} done
      </Text>
      {tasks.length === 0 ? (
        <Text dimColor>No tasks — the planner creates them with task_create when dispatching work.</Text>
      ) : (
        <>
          <Text dimColor>{start > 0 ? "  ▲ more" : " "}</Text>
          {windowItems.map((t) => (
            <Text key={t.id} wrap="truncate-end">
              {t.status === "completed" ? (
                <Text dimColor strikethrough>
                  ✔ {t.subject}
                </Text>
              ) : t.status === "in_progress" ? (
                <Text color="yellow" bold>
                  ▶ {t.subject}
                </Text>
              ) : (
                <Text>☐ {t.subject}</Text>
              )}
              {t.owner ? <Text color={ownerColor(t.owner)}> @{t.owner}</Text> : null}
            </Text>
          ))}
          <Text dimColor>{start + maxVisible < sorted.length ? "  ▼ more" : " "}</Text>
        </>
      )}
      <Text dimColor>↑↓ scroll · esc / ⌃P close</Text>
    </Box>
  )
}
