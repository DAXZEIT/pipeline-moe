import { Box, Text } from "ink"
import type { RosterItem } from "@pipeline-moe/client-core"
import { useTerminalSize } from "../useTerminalSize"
import { renderStrip, stripCells } from "../roster-strip"

/** Horizontal roster timeline under the room tabs — the running agent's cell
 *  is highlighted inverse in its color, paused agents dim out, and a second
 *  row names each agent's model when any is pinned. Replaces the vertical
 *  sidebar; Ctrl+R has the detail (full model ref, ctx, stats) and actions.
 *  Rendered as pre-painted ANSI strings in flat <Text>s so the strip's height
 *  is provably its row count (see renderStrip / stripRowCount). */
export function RosterStrip({ roster, runningId }: { roster: RosterItem[]; runningId: string | null }) {
  const { columns } = useTerminalSize()
  if (roster.length === 0) return null
  const rows = renderStrip(stripCells(roster, runningId, columns))
  return (
    <Box flexDirection="column" paddingX={1}>
      {rows.map((r, i) => (
        <Text key={i} wrap="truncate-end">
          {r}
        </Text>
      ))}
    </Box>
  )
}
