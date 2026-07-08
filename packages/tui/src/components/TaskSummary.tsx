import { Box, Text } from "ink"
import type { RoomTask } from "@pipeline-moe/client-core"

/** Compact task-board summary under the Roster: progress count + what is in
 *  flight right now. Renders nothing while the board is empty (most rooms,
 *  most of the time). Full board: Ctrl+P / /tasks. */
export function TaskSummary({ tasks, width }: { tasks: RoomTask[]; width: number }) {
  if (tasks.length === 0) return null
  const done = tasks.filter((t) => t.status === "completed").length
  const inProgress = tasks.filter((t) => t.status === "in_progress")
  // Show what's active; if nothing is claimed yet, show the next pending task.
  const shown = inProgress.length > 0 ? inProgress.slice(0, 3) : tasks.filter((t) => t.status === "pending").slice(0, 1)

  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold color="cyan" wrap="truncate-end">
        TASKS {done}/{tasks.length} <Text dimColor>⌃P</Text>
      </Text>
      {shown.map((t) => (
        <Text key={t.id} color={t.status === "in_progress" ? "yellow" : undefined} dimColor={t.status === "pending"} wrap="truncate-end">
          {t.status === "in_progress" ? "▶" : "☐"} {t.subject}
        </Text>
      ))}
    </Box>
  )
}
