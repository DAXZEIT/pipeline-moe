import { Box, Text } from "ink"
import type { Message, RosterItem } from "@pipeline-moe/client-core"

/**
 * The conversation view. Renders the last `maxLines` completed messages plus any
 * in-flight streaming buffers (one per running agent) below them, so a turn's
 * text appears live as `token` deltas accumulate. Markdown is rendered raw for
 * now — terminal markdown is a follow-up.
 */
export function Transcript({
  messages,
  roster,
  streaming,
  maxLines,
}: {
  messages: Message[]
  roster: RosterItem[]
  streaming: Record<string, string>
  maxLines: number
}) {
  const byId = new Map(roster.map((r) => [r.id, r]))
  const colorOf = (author: string) => (author === "user" ? "white" : byId.get(author)?.color ?? "magenta")
  const nameOf = (author: string, fallback: string) =>
    author === "user" ? "You" : byId.get(author)?.name ?? fallback

  const recent = messages.slice(-maxLines)
  const live = Object.entries(streaming).filter(([, text]) => text.length > 0)

  return (
    <Box flexDirection="column" flexGrow={1}>
      {recent.map((m) => (
        <Box key={m.index} flexDirection="column" marginBottom={1}>
          <Text bold color={colorOf(m.author)}>
            {nameOf(m.author, m.authorName)}
          </Text>
          <Text>{m.text || <Text dimColor>(no response)</Text>}</Text>
        </Box>
      ))}
      {live.map(([id, text]) => (
        <Box key={`stream-${id}`} flexDirection="column" marginBottom={1}>
          <Text bold color={colorOf(id)}>
            {nameOf(id, id)} <Text color="yellow">▌</Text>
          </Text>
          <Text>{text}</Text>
        </Box>
      ))}
    </Box>
  )
}
