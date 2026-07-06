import { Box, Text } from "ink"
import type { RoomSummary } from "@pipeline-moe/client-core"

/**
 * Browser-style room tabs plus a trailing "+ room" tab, like the web UI's tab
 * bar. ←/→ on an empty command line cycles rooms and the + tab (wired in App
 * via CommandLine's onRoomNav — the arrows keep their cursor role while
 * typing); ⏎ on the selected + tab opens the create-room form. A room whose
 * goal is still running gets a dot so background sub-rooms are visible at a
 * glance.
 */
export function RoomTabs({
  rooms,
  current,
  plusSelected,
}: {
  rooms: RoomSummary[]
  current: string
  plusSelected: boolean
}) {
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
      <Text dimColor>{plusSelected ? "  ⏎ create" : "  ←→ switch"}</Text>
    </Box>
  )
}
