import { Box, Text } from "ink"
import type { Notice } from "@pipeline-moe/client-core"

/**
 * Render transient notices (command confirmations, errors, async results).
 * The store already TTL-expires them; we just show the most recent few so a
 * burst never pushes the composer off-screen.
 */
export function Notices({ notices }: { notices: Notice[] }) {
  if (notices.length === 0) return null
  const recent = notices.slice(-3)
  return (
    <Box flexDirection="column" paddingX={1}>
      {recent.map((n) => (
        <Text key={n.id} color={n.level === "error" ? "red" : "gray"}>
          {n.level === "error" ? "✗ " : "› "}
          {n.msg}
        </Text>
      ))}
    </Box>
  )
}
