import { Box, Text, useInput } from "ink"
import { useState } from "react"

/**
 * A minimal single-line composer. Uses Ink's `useInput` rather than pulling in
 * ink-text-input — enough to type a message and send on Enter. Ctrl+C quits via
 * Ink's default handler.
 */
export function Composer({ onSubmit, disabled }: { onSubmit: (text: string) => void; disabled?: boolean }) {
  const [value, setValue] = useState("")

  useInput((input, key) => {
    if (key.return) {
      const text = value.trim()
      if (text) onSubmit(text)
      setValue("")
      return
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1))
      return
    }
    // Ignore control/meta chords (Ctrl+C is handled by Ink itself).
    if (key.ctrl || key.meta || key.escape) return
    if (input) setValue((v) => v + input)
  })

  return (
    <Box borderStyle="round" borderColor={disabled ? "gray" : "cyan"} paddingX={1}>
      <Text color="cyan">{"› "}</Text>
      {value ? (
        <Text>{value}</Text>
      ) : (
        <Text dimColor>Message the room — Enter to send · Ctrl+C to quit</Text>
      )}
    </Box>
  )
}
