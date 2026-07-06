import { Box, Text, useInput } from "ink"
import { useState } from "react"
import { matchCommands } from "../commands/registry"

/**
 * The input line. Plain text is sent as a room message; a leading "/" turns it
 * into a command, with a live fuzzy palette (Claude-Code style) while typing the
 * command name. Enter dispatches; Tab completes the highlighted command; Esc
 * clears. Editing is full-line: ←/→ move the cursor, Ctrl+A/Ctrl+E jump to
 * start/end, Backspace/Delete cut around it, and typing inserts at the cursor.
 * Gated by `isActive` so overlays can take over the keyboard.
 */
export function CommandLine({
  onSend,
  onCommand,
  onRoomNav,
  isActive,
  connected,
}: {
  onSend: (text: string) => void
  onCommand: (input: string) => void
  /** ←/→ on an empty line cycles rooms (the arrows keep their cursor role while typing). */
  onRoomNav?: (dir: -1 | 1) => void
  isActive: boolean
  connected: boolean
}) {
  const [value, setValue] = useState("")
  const [cursor, setCursor] = useState(0)
  const [pIndex, setPIndex] = useState(0)

  const isSlash = value.startsWith("/")
  const head = isSlash ? value.slice(1).split(" ")[0] : ""
  const showPalette = isSlash && !value.includes(" ")
  const matches = showPalette ? matchCommands(head) : []
  const idx = matches.length ? Math.min(pIndex, matches.length - 1) : 0

  const reset = () => {
    setValue("")
    setCursor(0)
    setPIndex(0)
  }

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
        reset()
        return
      }
      if (key.escape) {
        reset()
        return
      }
      if (matches.length > 0 && key.tab) {
        const next = "/" + matches[idx].name + " "
        setValue(next)
        setCursor(next.length)
        setPIndex(0)
        return
      }
      // Palette navigation owns ↑/↓ only while it's open; the cursor owns ←/→.
      if (matches.length > 0 && key.upArrow) {
        setPIndex((p) => (p - 1 + matches.length) % matches.length)
        return
      }
      if (matches.length > 0 && key.downArrow) {
        setPIndex((p) => (p + 1) % matches.length)
        return
      }
      if (key.leftArrow) {
        if (!value && onRoomNav) return onRoomNav(-1)
        setCursor((c) => Math.max(0, c - 1))
        return
      }
      if (key.rightArrow) {
        if (!value && onRoomNav) return onRoomNav(1)
        setCursor((c) => Math.min(value.length, c + 1))
        return
      }
      if (key.ctrl && input === "a") {
        setCursor(0)
        return
      }
      if (key.ctrl && input === "e") {
        setCursor(value.length)
        return
      }
      if (key.backspace) {
        if (cursor > 0) {
          setValue((v) => v.slice(0, cursor - 1) + v.slice(cursor))
          setCursor((c) => c - 1)
        }
        return
      }
      if (key.delete) {
        // Some terminals map Backspace to the Delete key; treat it as backspace
        // when there's nothing to the right, otherwise as a forward delete.
        if (cursor < value.length) {
          setValue((v) => v.slice(0, cursor) + v.slice(cursor + 1))
        } else if (cursor > 0) {
          setValue((v) => v.slice(0, cursor - 1))
          setCursor((c) => c - 1)
        }
        return
      }
      if (key.ctrl || key.meta || key.tab) return
      if (input) {
        setValue((v) => v.slice(0, cursor) + input + v.slice(cursor))
        setCursor((c) => c + input.length)
      }
    },
    { isActive },
  )

  // The visible text drops the leading "/" (shown as a colored prompt glyph), so
  // the cursor maps one slot left when in slash mode.
  const disp = isSlash ? value.slice(1) : value
  const dcur = isSlash ? Math.max(0, cursor - 1) : cursor
  const before = disp.slice(0, dcur)
  const atChar = disp[dcur] ?? " "
  const after = disp.slice(dcur + 1)

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
          <Text>
            {before}
            <Text inverse>{atChar}</Text>
            {after}
          </Text>
        ) : (
          <Text dimColor>Message the room · / for commands · Ctrl+C to quit</Text>
        )}
      </Box>
    </Box>
  )
}
