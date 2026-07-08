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
  isActive,
}: {
  presets: PresetFile[]
  store: RoomStore
  onCancel: () => void
  isActive: boolean
}) {
  const [index, setIndex] = useState(0)
  const { rows } = useTerminalSize()
  const cursor = Math.min(index, Math.max(0, presets.length - 1))
  const current = presets[cursor]

  useInput(
    (input, key) => {
      if (key.escape) return onCancel()
      // Nothing to pick — any key dismisses, same as SelectOverlay, so the
      // overlay never reads as a stuck modal.
      if (presets.length === 0) return onCancel()
      if (key.upArrow) return setIndex((cursor - 1 + presets.length) % presets.length)
      if (key.downArrow) return setIndex((cursor + 1) % presets.length)
      if (key.return) {
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
      }
    },
    { isActive },
  )

  const { listVisible, previewMax } = presetPickerLayout(rows, presets.length)
  let start = cursor - Math.floor(listVisible / 2)
  start = Math.max(0, Math.min(start, presets.length - listVisible))
  const windowItems = presets.slice(start, start + listVisible)
  const hasAbove = start > 0
  const hasBelow = start + listVisible < presets.length
  const { shown, hidden } = previewPersonas(current, previewMax)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta" bold>
        Presets
        {presets.length > listVisible ? <Text dimColor>{`  ${cursor + 1}/${presets.length}`}</Text> : null}
      </Text>
      {presets.length === 0 ? (
        <Text dimColor>No saved presets — /preset save &lt;name&gt; stores the current line-up.</Text>
      ) : (
        <>
          <Text dimColor>{hasAbove ? "  ▲ more" : " "}</Text>
          {windowItems.map((p, i) => {
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
          <Text dimColor>{hasBelow ? "  ▼ more" : " "}</Text>
          <Text> </Text>
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
      <Text dimColor>⏎ load · a apply · ↑↓ select · esc cancel</Text>
    </Box>
  )
}
