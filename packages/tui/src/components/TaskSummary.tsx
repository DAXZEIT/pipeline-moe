import { Box, Text } from "ink"
import type { RoomTask } from "@pipeline-moe/client-core"

/** One-line task-board summary under the roster strip: progress count + what
 *  is in flight right now. Renders nothing while the board is empty (most
 *  rooms, most of the time — costs zero rows then). Full board: Ctrl+P. */
export function TaskSummary({ tasks }: { tasks: RoomTask[] }) {
  if (tasks.length === 0) return null
  const done = tasks.filter((t) => t.status === "completed").length
  const inProgress = tasks.filter((t) => t.status === "in_progress")
  // Show what's active; if nothing is claimed yet, show the next pending task.
  const shown = inProgress.length > 0 ? inProgress.slice(0, 2) : tasks.filter((t) => t.status === "pending").slice(0, 1)

  return (
    <Box paddingX={1}>
      <Text wrap="truncate-end">
        <Text bold color="cyan">
          TASKS {done}/{tasks.length}
        </Text>
        {shown.map((t) => (
          <Text key={t.id} color={t.status === "in_progress" ? "yellow" : undefined} dimColor={t.status === "pending"}>
            {"  "}
            {t.status === "in_progress" ? "▶" : "☐"} {t.subject}
          </Text>
        ))}
        <Text dimColor>  ⌃P</Text>
      </Text>
    </Box>
  )
}
