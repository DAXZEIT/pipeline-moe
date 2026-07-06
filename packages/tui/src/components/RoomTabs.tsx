import { Box, Text } from "ink"
import type { RoomSummary } from "@pipeline-moe/client-core"

/**
 * Browser-style room tabs, shown only when more than one room is open.
 * ←/→ on an empty command line cycles through them (wired in App via
 * CommandLine's onRoomNav — the arrows keep their cursor role while typing).
 * A room whose goal is still running gets a yellow dot so background
 * sub-rooms are visible at a glance.
 */
export function RoomTabs({ rooms, current }: { rooms: RoomSummary[]; current: string }) {
  if (rooms.length < 2) return null
  return (
    <Box paddingX={1} flexWrap="wrap">
      {rooms.map((r) => {
        const active = r.roomId === current
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
      <Text dimColor>←→ switch</Text>
    </Box>
  )
}
