import { Box, Text } from "ink"
import type { RosterItem } from "@pipeline-moe/client-core"
import { shortModel } from "../commands/registry"
import { useTerminalSize } from "../useTerminalSize"

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

  // Model badges double each agent's footprint — drop back to one line per
  // agent when the terminal is too short for the expanded roster.
  const { rows } = useTerminalSize()
  const showModels = roster.length * 2 + 3 <= rows - 8

  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold color="cyan">
        ROSTER {activeCount}/{roster.length}
      </Text>
      {roster.map((p) => (
        <Box key={p.id} flexDirection="column">
          <Text color={p.active ? p.color : "gray"} dimColor={!p.active}>
            {STATUS_GLYPH[p.status]} {p.icon} {p.name}
          </Text>
          {showModels ? (
            <Text dimColor wrap="truncate-end">
              {"  "}
              {p.model ? (p.model.startsWith("local/") ? "🖥 " : "☁ ") : ""}
              {shortModel(p.model) ?? "default"}
            </Text>
          ) : null}
        </Box>
      ))}
    </Box>
  )
}
