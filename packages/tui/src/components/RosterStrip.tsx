import { Box, Text } from "ink"
import type { RosterItem } from "@pipeline-moe/client-core"
import { useTerminalSize } from "../useTerminalSize"
import { renderStrip, stripCells } from "../roster-strip"

/** Horizontal roster timeline under the room tabs — the running agent's cell
 *  is highlighted inverse in its color, paused agents dim out. Replaces the
 *  vertical sidebar; Ctrl+R has the detail (model, ctx, stats) and actions.
 *  Rendered as ONE pre-painted ANSI string in a single flat <Text> so the
 *  strip is provably one row (see renderStrip). */
export function RosterStrip({ roster, runningId }: { roster: RosterItem[]; runningId: string | null }) {
  const { columns } = useTerminalSize()
  if (roster.length === 0) return null
  const cells = stripCells(roster, runningId, columns)
  return (
    <Box paddingX={1}>
      <Text wrap="truncate-end">{renderStrip(cells)}</Text>
    </Box>
  )
}
