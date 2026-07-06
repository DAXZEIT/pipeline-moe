import { Box, Text, useInput, useStdout } from "ink"
import type { RoomStore, PresetFile } from "@pipeline-moe/client-core"
import { shortModel } from "../../commands/registry"

/**
 * Detail view of one saved preset — the TUI counterpart of the web UI's
 * PRESETS tab: every persona with its model and tool set, so you can see what
 * a preset really contains before committing to it. Two ways in:
 *   ⏎  load  — start a new discussion with this roster
 *   a  apply — swap the roster in-place, keeping the current transcript
 * Esc goes back to the preset list.
 */
export function PresetDetailOverlay({
  preset,
  store,
  onClose,
  onBack,
  isActive,
}: {
  preset: PresetFile
  store: RoomStore
  onClose: () => void
  onBack?: () => void
  isActive: boolean
}) {
  const { stdout } = useStdout()

  useInput(
    (input, key) => {
      if (key.escape) {
        onClose()
        onBack?.()
        return
      }
      if (key.return) {
        onClose()
        store.actions
          .loadPreset(preset.name)
          .then(() => store.pushNotice(`Loaded preset "${preset.name}" — new discussion.`))
          .catch(() => {})
        return
      }
      if (input === "a") {
        onClose()
        store.actions
          .applyPreset(preset.name)
          .then(() => store.pushNotice(`Applied preset "${preset.name}" — roster swapped, transcript kept.`))
          .catch(() => {})
      }
    },
    { isActive },
  )

  // Two rows per persona (name+model, tools) — cap to the terminal height and
  // say how many more there are rather than pushing the chrome off-screen.
  const rows = stdout?.rows ?? 24
  const maxPersonas = Math.max(2, Math.floor((rows - 12) / 2))
  const shown = preset.personas.slice(0, maxPersonas)
  const hidden = preset.personas.length - shown.length

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta" bold>
        Preset · {preset.name}
        <Text dimColor>{`  ${preset.personas.length} agents`}</Text>
      </Text>
      {shown.map((p) => (
        <Box key={p.id} flexDirection="column">
          <Text>
            <Text color={p.color}>
              {p.icon} {p.name}
            </Text>
            {"  "}
            <Text color="cyan">{shortModel(p.model) ?? "room default"}</Text>
            {p.active === false ? <Text dimColor> ○paused</Text> : null}
            {p.parallel ? <Text dimColor> ∥</Text> : null}
          </Text>
          <Text dimColor wrap="truncate-end">
            {"   "}
            {p.tools.length ? p.tools.join(" · ") : "no tools"}
          </Text>
        </Box>
      ))}
      {hidden > 0 ? <Text dimColor>{`  … +${hidden} more agents`}</Text> : null}
      <Text dimColor>⏎ load (new discussion) · a apply (keep transcript) · esc back</Text>
    </Box>
  )
}
