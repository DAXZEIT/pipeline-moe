import { Box, Text } from "ink"
import type { RosterItem, RoutingMode } from "@pipeline-moe/client-core"
import { ROUTING_COLOR } from "../input-mode"

/** One-line room status. `connection` distinguishes the EventSource retrying
 *  after a drop (reconnecting) from the initial connect, since the store only
 *  exposes a boolean and the stream auto-retries until stopped. */
export function StatusBar({
  connection,
  turnActive,
  runningAgent,
  paused,
  pausedAskerId,
  routingMode,
  roomId,
  messageCount,
}: {
  connection: "connecting" | "connected" | "reconnecting"
  turnActive: boolean
  runningAgent: RosterItem | null
  paused: boolean
  pausedAskerId: string | null
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
      {paused ? (
        // An ask_user pause is NOT idle — the room holds a frozen queue and
        // waits on the user. Saying "idle" here made a legitimate 409 on other
        // actions read as a corrupted state.
        <Text color="magenta">
          ⏸ paused — waiting for your answer{pausedAskerId ? ` to @${pausedAskerId}` : ""}
        </Text>
      ) : turnActive ? (
        <Text color="yellow">
          ▶ running
          {runningAgent ? (
            <Text color={runningAgent.color}>
              {" "}
              {runningAgent.icon} {runningAgent.name}
            </Text>
          ) : null}
          <Text dimColor> — Esc to stop</Text>
        </Text>
      ) : (
        <Text color="gray">idle</Text>
      )}
      {/* routing gets the same color the input border wears in plain-text
          mode — one color per meaning across the whole chrome. */}
      <Text dimColor>{"   "}routing:</Text>
      <Text color={ROUTING_COLOR[routingMode]}>{routingMode}</Text>
      <Text dimColor>
        {"  "}room:{roomId}
        {"  "}msgs:{messageCount}
      </Text>
    </Box>
  )
}
