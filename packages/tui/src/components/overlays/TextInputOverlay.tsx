import { Box, Text, useInput } from "ink"
import { useState } from "react"

/**
 * A one-line modal prompt. Same editing model as the command line (←/→,
 * Ctrl+A/E, backspace/delete, insert-at-cursor incl. paste); Enter submits a
 * non-empty value, Esc cancels. With `mask`, everything but the last 4 chars
 * renders as bullets so a pasted API key can be sanity-checked without being
 * readable over a shoulder.
 */
export function TextInputOverlay({
  title,
  placeholder,
  mask,
  onSubmit,
  onCancel,
  isActive,
}: {
  title: string
  placeholder?: string
  mask?: boolean
  onSubmit: (value: string) => void
  onCancel: () => void
  isActive: boolean
}) {
  const [value, setValue] = useState("")
  const [cursor, setCursor] = useState(0)

  useInput(
    (input, key) => {
      if (key.escape) return onCancel()
      if (key.return) {
        const v = value.trim()
        if (v) onSubmit(v)
        return
      }
      if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1))
      if (key.rightArrow) return setCursor((c) => Math.min(value.length, c + 1))
      if (key.ctrl && input === "a") return setCursor(0)
      if (key.ctrl && input === "e") return setCursor(value.length)
      if (key.backspace) {
        if (cursor > 0) {
          setValue((v) => v.slice(0, cursor - 1) + v.slice(cursor))
          setCursor((c) => c - 1)
        }
        return
      }
      if (key.delete) {
        if (cursor < value.length) {
          setValue((v) => v.slice(0, cursor) + v.slice(cursor + 1))
        } else if (cursor > 0) {
          setValue((v) => v.slice(0, cursor - 1))
          setCursor((c) => c - 1)
        }
        return
      }
      if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) return
      if (input) {
        // Strip control chars a paste can carry (CR/LF/tabs) so a key pasted
        // with a trailing newline doesn't garble the value.
        const clean = input.replace(/[\r\n\t]/g, "")
        if (!clean) return
        setValue((v) => v.slice(0, cursor) + clean + v.slice(cursor))
        setCursor((c) => c + clean.length)
      }
    },
    { isActive },
  )

  const shown = mask && value.length > 4 ? "•".repeat(value.length - 4) + value.slice(-4) : value
  const before = shown.slice(0, cursor)
  const atChar = shown[cursor] ?? " "
  const after = shown.slice(cursor + 1)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta" bold>
        {title}
      </Text>
      <Box>
        <Text color="magenta">› </Text>
        {value ? (
          <Text>
            {before}
            <Text inverse>{atChar}</Text>
            {after}
          </Text>
        ) : (
          <Text dimColor>{placeholder ?? ""}</Text>
        )}
      </Box>
      <Text dimColor>⏎ submit · esc cancel</Text>
    </Box>
  )
}
