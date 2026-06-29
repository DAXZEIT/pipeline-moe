import { Box, Text } from "ink"
import type { RoutingMode } from "@pipeline-moe/client-core"

export function StatusBar({
  connected,
  turnActive,
  runningAgentId,
  routingMode,
  roomId,
  messageCount,
}: {
  connected: boolean
  turnActive: boolean
  runningAgentId: string | null
  routingMode: RoutingMode
  roomId: string
  messageCount: number
}) {
  return (
    <Box paddingX={1}>
      <Text color={connected ? "green" : "red"}>{connected ? "● connected" : "○ offline"}</Text>
      <Text>{"  "}</Text>
      <Text color={turnActive ? "yellow" : "gray"}>
        {turnActive ? `▶ running${runningAgentId ? ` @${runningAgentId}` : ""}` : "idle"}
      </Text>
      <Text dimColor>
        {"   "}routing:{routingMode}{"  "}room:{roomId}{"  "}msgs:{messageCount}
      </Text>
    </Box>
  )
}
