import { Box, Text } from "ink"
import type { RosterItem, RoutingMode } from "@pipeline-moe/client-core"

/** One-line room status. `connection` distinguishes the EventSource retrying
 *  after a drop (reconnecting) from the initial connect, since the store only
 *  exposes a boolean and the stream auto-retries until stopped. */
export function StatusBar({
  connection,
  turnActive,
  runningAgent,
  routingMode,
  roomId,
  messageCount,
}: {
  connection: "connecting" | "connected" | "reconnecting"
  turnActive: boolean
  runningAgent: RosterItem | null
  routingMode: RoutingMode
  roomId: string
  messageCount: number
}) {
  const conn =
    connection === "connected"
      ? { color: "green", label: "● connected" }
      : connection === "reconnecting"
        ? { color: "yellow", label: "◌ reconnecting…" }
        : { color: "gray", label: "○ connecting…" }
  return (
    <Box paddingX={1}>
      <Text color={conn.color}>{conn.label}</Text>
      <Text>{"  "}</Text>
      {turnActive ? (
        <Text color="yellow">
          ▶ running
          {runningAgent ? (
            <Text color={runningAgent.color}>
              {" "}
              {runningAgent.icon} {runningAgent.name}
            </Text>
          ) : null}
        </Text>
      ) : (
        <Text color="gray">idle</Text>
      )}
      <Text dimColor>
        {"   "}routing:{routingMode}
        {"  "}room:{roomId}
        {"  "}msgs:{messageCount}
      </Text>
    </Box>
  )
}
