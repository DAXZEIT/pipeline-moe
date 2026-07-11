import { Box, Text, useInput } from "ink"
import { useState } from "react"
import type { RoomStore, PresetFile } from "@pipeline-moe/client-core"
import { useTerminalSize } from "../../useTerminalSize"
import { shortModel } from "../../commands/registry"
import { presetSummary, presetPickerLayout, previewPersonas } from "../../preset-picker"

/**
 * The TUI counterpart of the web UI's PRESETS accordion — one overlay with
 * the preset list AND a live preview of the highlighted preset's agents
 * (model + tools per agent), instead of the old two-step flow (SelectOverlay
 * -> a separate PresetDetailOverlay you had to press Enter to reach). ↑/↓
 * moves the preview along with the cursor; there's no "open detail" step.
 *   ⏎  load  — start a new discussion with this roster
 *   a  apply — swap the roster in-place, keeping the current transcript
 * The list always ends with a virtual "＋ new" row — ⏎ there opens the
 * composer on a blank roster, so /preset alone is a complete entry point
 * (list, load, remix, or start from scratch) even before any preset exists.
 *
 * No typing-to-filter here, unlike SelectOverlay: a bare "a" key is the
 * apply shortcut, and a filter-typing mode would need a second key just to
 * disambiguate "a" from "start typing" — not worth the extra interaction
 * for a preset list, which in practice stays short (arrow keys are enough).
 * If the list grows enough that this stops being true, that's a cheap,
 * well-scoped follow-up, not something to preempt here.
 */
export function PresetPickerOverlay({
  presets,
  store,
  onCancel,
  onCompose,
  isActive,
}: {
  presets: PresetFile[]
  store: RoomStore
  onCancel: () => void
  /** Open a preset in the composer — n key (remix, isNew false) or the
   *  "＋ new" row (blank roster, isNew true). */
  onCompose?: (preset: PresetFile, isNew: boolean) => void
  isActive: boolean
}) {
  const [index, setIndex] = useState(0)
  const { rows } = useTerminalSize()
  // The virtual "＋ new" row lives past the end of `presets`.
  const total = presets.length + 1
  const cursor = Math.min(index, total - 1)
  const current: PresetFile | undefined = presets[cursor]
  const onNewRow = cursor === presets.length

  useInput(
    (input, key) => {
      if (key.escape) return onCancel()
      if (key.upArrow) return setIndex((cursor - 1 + total) % total)
      if (key.downArrow) return setIndex((cursor + 1) % total)
      if (key.return) {
        if (onNewRow) {
          if (onCompose) onCompose({ name: "", personas: [] }, true)
          return
        }
        if (!current) return
        onCancel()
        store.actions
          .loadPreset(current.name)
          .then(() => store.pushNotice(`Loaded preset "${current.name}" — new discussion.`))
          .catch(() => {})
        return
      }
      if (input === "a") {
        if (!current) return
        onCancel()
        store.actions
          .applyPreset(current.name)
          .then(() => store.pushNotice(`Applied preset "${current.name}" — roster swapped, transcript kept.`))
          .catch(() => {})
        return
      }
      if (input === "n" && onCompose) {
        if (!current) return
        // The composer replaces this overlay (overlays don't stack).
        onCompose(current, false)
      }
    },
    { isActive },
  )

  const { listVisible, previewMax } = presetPickerLayout(rows, total)
  let start = cursor - Math.floor(listVisible / 2)
  start = Math.max(0, Math.min(start, total - listVisible))
  const windowEnd = start + listVisible
  const hasAbove = start > 0
  const hasBelow = windowEnd < total
  const { shown, hidden } = previewPersonas(current, previewMax)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta" bold>
        Presets
        {total > listVisible ? <Text dimColor>{`  ${cursor + 1}/${total}`}</Text> : null}
      </Text>
      <Text dimColor>{hasAbove ? "  ▲ more" : " "}</Text>
      {presets.slice(start, Math.min(windowEnd, presets.length)).map((p, i) => {
        const real = start + i
        return (
          <Box key={p.name} justifyContent="space-between">
            <Text color={real === cursor ? "magenta" : undefined} inverse={real === cursor}>
              {real === cursor ? "▶ " : "  "}
              {p.name}
            </Text>
            <Text dimColor> {presetSummary(p)}</Text>
          </Box>
        )
      })}
      {windowEnd > presets.length ? (
        <Box justifyContent="space-between">
          <Text color={onNewRow ? "magenta" : "green"} inverse={onNewRow}>
            {onNewRow ? "▶ " : "  "}＋ new
          </Text>
          <Text dimColor> compose a team from scratch</Text>
        </Box>
      ) : null}
      <Text dimColor>{hasBelow ? "  ▼ more" : " "}</Text>
      <Text> </Text>
      {onNewRow ? (
        <Text dimColor>Opens the composer on an empty roster — a add member, s save.</Text>
      ) : (
        <>
          {shown.map((p) => (
            <Text key={p.id} wrap="truncate-end">
              <Text color={p.color}>
                {p.icon} {p.name}
              </Text>
              {"  "}
              <Text color="cyan">{shortModel(p.model) ?? "default"}</Text>
              {p.tools.length ? <Text dimColor>{"  " + p.tools.join(" ")}</Text> : null}
            </Text>
          ))}
          {hidden > 0 ? <Text dimColor>{`  … +${hidden} more agents`}</Text> : null}
        </>
      )}
      <Text dimColor>{onNewRow ? "⏎ compose · ↑↓ select · esc cancel" : "⏎ load · a apply · n remix · ↑↓ select · esc cancel"}</Text>
    </Box>
  )
}
