import { Box, Text, useInput } from "ink"
import { useTerminalSize } from "../../useTerminalSize"
import { useState } from "react"
import type { SelectItem } from "../../commands/types"

/**
 * A reusable modal list picker. Drives /resume, /template, /providers, /rooms,
 * /model, /help and /preset load. A long list (e.g. 277 models) is windowed:
 * only `maxVisible` rows render at once, the window follows the cursor, and
 * ▲/▼ markers plus an "n/total" counter show there's more above/below — so the
 * title and key hint never get pushed off-screen. Typing filters the list
 * (case-insensitive, matches label + hint); backspace edits the filter.
 * `isActive` gates the input so it never competes with the command line.
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
  const [query, setQuery] = useState("")
  const { rows } = useTerminalSize()

  const q = query.toLowerCase()
  const filtered = q
    ? items.filter((it) => (it.label + " " + (it.hint ?? "")).toLowerCase().includes(q))
    : items
  // Clamp instead of resetting state: the list can shrink under the cursor.
  const cursor = Math.min(index, Math.max(0, filtered.length - 1))

  useInput(
    (input, key) => {
      if (key.escape) return onCancel()
      // A list with nothing to pick — let any key dismiss it, so the overlay
      // never reads as a stuck modal. (A filter with no match stays editable.)
      if (items.length === 0) return onCancel()
      if (key.upArrow) return setIndex(filtered.length ? (cursor - 1 + filtered.length) % filtered.length : 0)
      if (key.downArrow) return setIndex(filtered.length ? (cursor + 1) % filtered.length : 0)
      if (key.return) {
        if (filtered.length) onSelect(filtered[cursor].id)
        return
      }
      if (key.backspace || key.delete) {
        if (query) {
          setQuery((v) => v.slice(0, -1))
          setIndex(0)
        }
        return
      }
      if (key.ctrl || key.meta || key.tab) return
      if (input) {
        setQuery((v) => v + input)
        setIndex(0)
      }
    },
    { isActive },
  )

  // Reserve rows for the surrounding chrome (transcript, status bar, command
  // line, borders) so the overlay itself never overflows a short terminal.
  const maxVisible = Math.max(3, Math.min(12, rows - 10))
  const visible = Math.min(filtered.length, maxVisible)

  // Center the cursor in the window, clamped at both ends — a pure derivation
  // from `cursor`, so there is no separate scroll state to drift out of sync.
  let start = cursor - Math.floor(visible / 2)
  start = Math.max(0, Math.min(start, filtered.length - visible))
  const windowItems = filtered.slice(start, start + visible)
  const hasAbove = start > 0
  const hasBelow = start + visible < filtered.length

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta" bold>
        {title}
        {filtered.length > visible ? <Text dimColor>{`  ${cursor + 1}/${filtered.length}`}</Text> : null}
        {query ? <Text color="yellow">{`  🔎 ${query}`}</Text> : null}
      </Text>
      {items.length === 0 ? (
        <Text dimColor>{emptyText ?? "Nothing to show."}</Text>
      ) : filtered.length === 0 ? (
        <Text dimColor>No match for “{query}” — backspace to edit.</Text>
      ) : (
        <>
          <Text dimColor>{hasAbove ? "  ▲ more" : " "}</Text>
          {windowItems.map((it, i) => {
            const real = start + i
            return (
              <Box key={it.id} justifyContent="space-between">
                <Text color={real === cursor ? "magenta" : undefined} inverse={real === cursor}>
                  {real === cursor ? "▶ " : "  "}
                  {it.label}
                </Text>
                {it.hint ? <Text dimColor> {it.hint}</Text> : null}
              </Box>
            )
          })}
          <Text dimColor>{hasBelow ? "  ▼ more" : " "}</Text>
        </>
      )}
      <Text dimColor>↑↓ select · ⏎ choose · type to filter · esc cancel</Text>
    </Box>
  )
}
