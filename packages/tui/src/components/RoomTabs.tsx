import { Box, Text } from "ink"
import type { RoomSummary } from "@pipeline-moe/client-core"

/**
 * Browser-style room tabs plus a trailing "+ room" tab, like the web UI's tab
 * bar. ←/→ on an empty command line cycles rooms and the + tab (wired in App
 * via CommandLine's onRoomNav — the arrows keep their cursor role while
 * typing); ⏎ on the selected + tab opens the create-room form. A room whose
 * goal is still running gets a dot so background sub-rooms are visible at a
 * glance.
 *
 * The trailing "💬 <title>" names the CURRENT discussion (the webUI shows this in
 * its ConversationBar; the TUI had no equivalent). It rides the existing tabs
 * row — no extra terminal row, so the `reservedRows` height budget is untouched.
 * The title is truncated so it stays on this one line; with many rooms the row
 * can still flex-wrap (pre-existing RoomTabs behavior), in which case a
 * dedicated budgeted line is the fallback.
 */
const MAX_TITLE = 28

export function RoomTabs({
  rooms,
  current,
  plusSelected,
  conversationTitle,
}: {
  rooms: RoomSummary[]
  current: string
  plusSelected: boolean
  conversationTitle?: string
}) {
  const shownTitle =
    conversationTitle && conversationTitle.length > MAX_TITLE
      ? conversationTitle.slice(0, MAX_TITLE - 1) + "…"
      : conversationTitle || "—"
  return (
    <Box paddingX={1} flexWrap="wrap">
      {rooms.map((r) => {
        const active = !plusSelected && r.roomId === current
        const busy = r.goalStatus === "running"
        return (
          <Text key={r.roomId}>
            <Text inverse={active} color={active ? "cyan" : undefined} dimColor={!active}>
              {" "}
              {busy ? "● " : ""}
              {r.name}{" "}
            </Text>
            <Text> </Text>
          </Text>
        )
      })}
      <Text inverse={plusSelected} color={plusSelected ? "green" : undefined} dimColor={!plusSelected}>
        {" "}+ room{" "}
      </Text>
      <Text dimColor>{plusSelected ? "  ⏎ create / resume" : "  ←→ switch"}</Text>
      <Text>
        <Text dimColor>{"  · 💬 "}</Text>
        <Text color="cyan">{shownTitle}</Text>
      </Text>
    </Box>
  )
}
