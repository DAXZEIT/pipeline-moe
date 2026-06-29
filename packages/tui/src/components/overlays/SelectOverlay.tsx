import { Box, Text, useInput } from "ink"
import { useState } from "react"
import type { SelectItem } from "../../commands/types"

/**
 * A reusable modal list picker. Drives /resume, /template and /preset load.
 * Renders nothing's-magic: a bordered box, a highlighted cursor row, and a
 * key hint. `isActive` gates the input so it never competes with the command
 * line (Ink delivers keystrokes to every mounted, active handler).
 */
export function SelectOverlay({
  title,
  items,
  emptyText,
  onSelect,
  onCancel,
  isActive,
}: {
  title: string
  items: SelectItem[]
  emptyText?: string
  onSelect: (id: string) => void
  onCancel: () => void
  isActive: boolean
}) {
  const [index, setIndex] = useState(0)

  useInput(
    (_input, key) => {
      if (key.escape) return onCancel()
      if (items.length === 0) return
      if (key.upArrow) setIndex((i) => (i - 1 + items.length) % items.length)
      else if (key.downArrow) setIndex((i) => (i + 1) % items.length)
      else if (key.return) onSelect(items[index].id)
    },
    { isActive },
  )

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta" bold>
        {title}
      </Text>
      {items.length === 0 ? (
        <Text dimColor>{emptyText ?? "Nothing to show."}</Text>
      ) : (
        items.map((it, i) => (
          <Box key={it.id} justifyContent="space-between">
            <Text color={i === index ? "magenta" : undefined} inverse={i === index}>
              {i === index ? "▶ " : "  "}
              {it.label}
            </Text>
            {it.hint ? <Text dimColor> {it.hint}</Text> : null}
          </Box>
        ))
      )}
      <Text dimColor>↑↓ select · ⏎ choose · esc cancel</Text>
    </Box>
  )
}
