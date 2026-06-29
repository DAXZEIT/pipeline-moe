import { Box, Text, useInput } from "ink"
import { useState } from "react"
import { matchCommands } from "../commands/registry"

/**
 * The input line. Plain text is sent as a room message; a leading "/" turns it
 * into a command, with a live fuzzy palette (Claude-Code style) while typing the
 * command name. Enter dispatches; Tab completes the highlighted command; Esc
 * clears. Gated by `isActive` so overlays can take over the keyboard.
 */
export function CommandLine({
  onSend,
  onCommand,
  isActive,
  connected,
}: {
  onSend: (text: string) => void
  onCommand: (input: string) => void
  isActive: boolean
  connected: boolean
}) {
  const [value, setValue] = useState("")
  const [pIndex, setPIndex] = useState(0)

  const isSlash = value.startsWith("/")
  const head = isSlash ? value.slice(1).split(" ")[0] : ""
  const showPalette = isSlash && !value.includes(" ")
  const matches = showPalette ? matchCommands(head) : []
  const idx = matches.length ? Math.min(pIndex, matches.length - 1) : 0

  useInput(
    (input, key) => {
      if (key.return) {
        const text = value.trim()
        if (text) {
          // While the palette is open, Enter runs the highlighted command
          // (so "/r"⏎ on ▶/resume runs /resume, not the ambiguous "/r").
          if (matches.length > 0) onCommand("/" + matches[idx].name)
          else if (text.startsWith("/")) onCommand(text)
          else onSend(text)
        }
        setValue("")
        setPIndex(0)
        return
      }
      if (key.escape) {
        setValue("")
        setPIndex(0)
        return
      }
      if (matches.length > 0 && key.tab) {
        setValue("/" + matches[idx].name + " ")
        setPIndex(0)
        return
      }
      if (matches.length > 0 && key.upArrow) {
        setPIndex((p) => (p - 1 + matches.length) % matches.length)
        return
      }
      if (matches.length > 0 && key.downArrow) {
        setPIndex((p) => (p + 1) % matches.length)
        return
      }
      if (key.backspace || key.delete) {
        setValue((v) => v.slice(0, -1))
        return
      }
      if (key.ctrl || key.meta || key.tab) return
      if (input) setValue((v) => v + input)
    },
    { isActive },
  )

  return (
    <Box flexDirection="column">
      {matches.length > 0 ? (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          {matches.map((c, i) => (
            <Box key={c.name} justifyContent="space-between">
              <Text color={i === idx ? "yellow" : undefined} inverse={i === idx}>
                {i === idx ? "▶ " : "  "}/{c.name}
                {c.usage ? <Text dimColor> {c.usage}</Text> : null}
              </Text>
              <Text dimColor> {c.summary}</Text>
            </Box>
          ))}
          <Text dimColor>↑↓ select · ⇥ complete · ⏎ run</Text>
        </Box>
      ) : null}
      <Box borderStyle="round" borderColor={isActive && connected ? "cyan" : "gray"} paddingX={1}>
        <Text color={isSlash ? "yellow" : "cyan"}>{isSlash ? "/ " : "› "}</Text>
        {value ? (
          <Text>{isSlash ? value.slice(1) : value}</Text>
        ) : (
          <Text dimColor>Message the room · / for commands · Ctrl+C to quit</Text>
        )}
      </Box>
    </Box>
  )
}
