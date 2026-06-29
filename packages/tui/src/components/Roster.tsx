import { Box, Text } from "ink"
import type { RosterItem } from "@pipeline-moe/client-core"

const STATUS_GLYPH: Record<RosterItem["status"], string> = {
  idle: "○",
  active: "●",
  thinking: "◐",
  working: "◑",
  compacting: "◒",
  retrying: "↻",
}

export function Roster({ roster, width }: { roster: RosterItem[]; width: number }) {
  const activeCount = roster.filter((r) => r.active).length
  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold color="cyan">
        ROSTER {activeCount}/{roster.length}
      </Text>
      {roster.map((p) => (
        <Text key={p.id} color={p.active ? p.color : "gray"} dimColor={!p.active}>
          {STATUS_GLYPH[p.status]} {p.icon} {p.name}
        </Text>
      ))}
    </Box>
  )
}
