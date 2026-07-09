import { Box, Text, useInput } from "ink"
import { useEffect, useState } from "react"
import type { Api, PresetFile } from "@pipeline-moe/client-core"
import { useTerminalSize } from "../../useTerminalSize"
import { shortModel } from "../../commands/registry"
import { presetSummary, previewPersonas, roomFormPreviewMax } from "../../preset-picker"

interface Field {
  key: "name" | "workspaceDir" | "goal"
  label: string
  placeholder: string
}

const NAME_ROW = 0
const PRESET_ROW = 1
const WORKDIR_ROW = 2
const GOAL_ROW = 3
const CREATE_ROW = 4

const TEXT_FIELDS: Record<number, Field> = {
  [NAME_ROW]: { key: "name", label: "Name", placeholder: "e.g. Cloud Sprint" },
  [WORKDIR_ROW]: {
    key: "workspaceDir",
    label: "Workdir",
    placeholder: "optional — /path or user@host:/path (SSHFS)",
  },
  [GOAL_ROW]: { key: "goal", label: "Goal", placeholder: "optional — auto-starts the room" },
}

/**
 * Create-room wizard — the TUI counterpart of the web UI's CREATE NEW modal:
 * name, preset roster (left/right cycles the saved presets), optional working
 * directory (local path or user@host:path mounted over SSHFS) and optional
 * goal (a goal auto-starts the room). Reached from the + room tab or /newroom.
 */
export function RoomForm({
  api,
  onCreated,
  onClose,
  isActive,
}: {
  api: Api
  onCreated: (roomId: string, name: string, hadGoal: boolean) => void
  onClose: () => void
  isActive: boolean
}) {
  const [values, setValues] = useState<Record<Field["key"], string>>({
    name: "",
    workspaceDir: "",
    goal: "",
  })
  const [presets, setPresets] = useState<PresetFile[]>([])
  const [presetIdx, setPresetIdx] = useState(0) // 0 = default roster
  const [focus, setFocus] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { rows } = useTerminalSize()

  useEffect(() => {
    api
      .presets()
      .then(setPresets)
      .catch(() => {})
  }, [api])

  const presetLabels = ["— default roster —", ...presets.map((p) => p.name)]
  const selectedPreset = presetIdx > 0 ? presets[presetIdx - 1] : undefined
  const preset = selectedPreset?.name

  const submit = () => {
    if (busy) return
    const name = values.name.trim()
    if (!name) {
      setError("Name is required.")
      return
    }
    setBusy(true)
    api
      .createRoom({
        name,
        ...(preset ? { preset } : {}),
        ...(values.workspaceDir.trim() ? { workspaceDir: values.workspaceDir.trim() } : {}),
        ...(values.goal.trim() ? { goal: values.goal.trim() } : {}),
      })
      .then((room) => {
        onClose()
        onCreated(room.roomId, name, Boolean(values.goal.trim()))
      })
      .catch((err: unknown) => {
        setBusy(false)
        setError(err instanceof Error && err.message ? err.message : "Create failed — server unreachable?")
      })
  }

  useInput(
    (input, key) => {
      if (key.escape) return onClose()
      if (key.upArrow) return setFocus((f) => Math.max(0, f - 1))
      if (key.downArrow || key.tab) return setFocus((f) => Math.min(CREATE_ROW, f + 1))
      if (key.return) {
        if (focus === CREATE_ROW) return submit()
        return setFocus((f) => f + 1)
      }
      if (focus === PRESET_ROW) {
        const n = presetLabels.length
        if (key.leftArrow) {
          setError(null)
          setPresetIdx((i) => (i - 1 + n) % n)
        }
        if (key.rightArrow) {
          setError(null)
          setPresetIdx((i) => (i + 1) % n)
        }
        return
      }
      if (focus === CREATE_ROW) return
      const field = TEXT_FIELDS[focus].key
      if (key.backspace || key.delete) {
        setError(null)
        setValues((v) => ({ ...v, [field]: v[field].slice(0, -1) }))
        return
      }
      if (key.ctrl || key.meta) return
      if (input) {
        // Pastes and coalesced keystrokes can arrive as one chunk with \r/\n
        // embedded — flatten newlines to spaces, drop other control chars.
        const clean = input.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "")
        if (clean) {
          setError(null)
          setValues((v) => ({ ...v, [field]: v[field] + clean }))
        }
      }
    },
    { isActive },
  )

  const textRow = (row: number) => {
    const f = TEXT_FIELDS[row]
    const focused = row === focus
    const val = values[f.key]
    return (
      <Box key={f.key}>
        <Text color={focused ? "green" : undefined}>{focused ? "▶ " : "  "}</Text>
        <Text dimColor>{f.label}: </Text>
        {val ? (
          <Text wrap="truncate-end">
            {val}
            {focused ? <Text color="green">▌</Text> : null}
          </Text>
        ) : (
          <Text dimColor>{f.placeholder}</Text>
        )}
      </Box>
    )
  }

  const presetFocused = focus === PRESET_ROW
  // Same per-agent preview as the Presets overlay (icon + name, model, tools)
  // so picking a preset here shows WHAT you're about to spawn, not just a name.
  const { shown, hidden } = previewPersonas(selectedPreset, roomFormPreviewMax(rows))
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Text color="green" bold>
        New room
      </Text>
      {textRow(NAME_ROW)}
      <Box>
        <Text color={presetFocused ? "green" : undefined}>{presetFocused ? "▶ " : "  "}</Text>
        <Text dimColor>Preset: </Text>
        <Text color={presetIdx > 0 ? "cyan" : undefined} dimColor={presetIdx === 0}>
          {presetFocused ? "‹ " : ""}
          {presetLabels[presetIdx]}
          {presetFocused ? " ›" : ""}
        </Text>
        {presets.length === 0 ? <Text dimColor> (no saved presets)</Text> : null}
        {selectedPreset ? <Text dimColor>  {presetSummary(selectedPreset)}</Text> : null}
      </Box>
      {shown.map((p) => (
        <Text key={p.id} wrap="truncate-end">
          {"    "}
          <Text color={p.color}>
            {p.icon} {p.name}
          </Text>
          {"  "}
          <Text color="cyan">{shortModel(p.model) ?? "default"}</Text>
          {p.tools.length ? <Text dimColor>{"  " + p.tools.join(" ")}</Text> : null}
        </Text>
      ))}
      {hidden > 0 ? <Text dimColor>{`      … +${hidden} more agents`}</Text> : null}
      {textRow(WORKDIR_ROW)}
      {textRow(GOAL_ROW)}
      <Box marginTop={1}>
        <Text inverse={focus === CREATE_ROW} color={focus === CREATE_ROW ? "green" : "gray"}>
          {focus === CREATE_ROW ? "▶ " : "  "}[ {busy ? "Creating…" : "Create room"} ]
        </Text>
      </Box>
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>
        {presetFocused ? "←→ preset · " : ""}↑↓ field · ⏎ next/create · esc cancel
      </Text>
    </Box>
  )
}
