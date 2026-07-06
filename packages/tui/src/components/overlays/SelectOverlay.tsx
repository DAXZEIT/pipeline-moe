import { Box, Text, useInput, useStdout } from "ink"
import { useState } from "react"
import type { SelectItem } from "../../commands/types"

/**
 * A reusable modal list picker. Drives /resume, /template, /providers, /rooms,
 * /help and /preset load. A long list (e.g. 36 providers) is windowed: only
 * `maxVisible` rows render at once, the window follows the cursor, and ▲/▼
 * markers plus an "n/total" counter show there's more above/below — so the
 * title and key hint never get pushed off-screen. `isActive` gates the input so
 * it never competes with the command line.
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
  const { stdout } = useStdout()

  useInput(
    (_input, key) => {
      if (key.escape) return onCancel()
      // An empty list has nothing to pick — let any key dismiss it, so the
      // overlay never reads as a stuck modal.
      if (items.length === 0) return onCancel()
      if (key.upArrow) setIndex((i) => (i - 1 + items.length) % items.length)
      else if (key.downArrow) setIndex((i) => (i + 1) % items.length)
      else if (key.return) onSelect(items[index].id)
    },
    { isActive },
  )

  // Reserve rows for the surrounding chrome (transcript, status bar, command
  // line, borders) so the overlay itself never overflows a short terminal.
  const rows = stdout?.rows ?? 24
  const maxVisible = Math.max(3, Math.min(12, rows - 10))
  const visible = Math.min(items.length, maxVisible)

  // Center the cursor in the window, clamped at both ends — a pure derivation
  // from `index`, so there is no separate scroll state to drift out of sync.
  let start = index - Math.floor(visible / 2)
  start = Math.max(0, Math.min(start, items.length - visible))
  const windowItems = items.slice(start, start + visible)
  const hasAbove = start > 0
  const hasBelow = start + visible < items.length

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta" bold>
        {title}
        {items.length > visible ? <Text dimColor>{`  ${index + 1}/${items.length}`}</Text> : null}
      </Text>
      {items.length === 0 ? (
        <Text dimColor>{emptyText ?? "Nothing to show."}</Text>
      ) : (
        <>
          <Text dimColor>{hasAbove ? "  ▲ more" : " "}</Text>
          {windowItems.map((it, i) => {
            const real = start + i
            return (
              <Box key={it.id} justifyContent="space-between">
                <Text color={real === index ? "magenta" : undefined} inverse={real === index}>
                  {real === index ? "▶ " : "  "}
                  {it.label}
                </Text>
                {it.hint ? <Text dimColor> {it.hint}</Text> : null}
              </Box>
            )
          })}
          <Text dimColor>{hasBelow ? "  ▼ more" : " "}</Text>
        </>
      )}
      <Text dimColor>↑↓ select · ⏎ choose · esc cancel</Text>
    </Box>
  )
}
