import { Box, Text, useInput } from "ink"
import { useEffect, useState } from "react"
import type { Api, ModelInfo, PresetFile } from "@pipeline-moe/client-core"
import { useTerminalSize } from "../../useTerminalSize"
import { shortModel } from "../../commands/registry"
import { presetSummary, previewPersonas, roomFormPreviewMax } from "../../preset-picker"

type RowKey = "name" | "preset" | "model" | "workspaceDir" | "goal" | "create"
type TextKey = "name" | "workspaceDir" | "goal"

const TEXT_FIELDS: Record<TextKey, { label: string; placeholder: string }> = {
  name: { label: "Name", placeholder: "e.g. Cloud Sprint" },
  workspaceDir: {
    label: "Workdir",
    placeholder: "optional — /path or user@host:/path (SSHFS)",
  },
  goal: { label: "Goal", placeholder: "optional — auto-starts the room" },
}

// Roster-cycle slots ahead of the saved presets: the default team, or a solo
// room (a bare pi — /solo's form twin). Solo swaps the preset preview for a
// Model row, since the model IS the choice there.
const DEFAULT_IDX = 0
const SOLO_IDX = 1

/**
 * Create-room wizard — the TUI counterpart of the web UI's CREATE NEW modal:
 * name, roster (left/right cycles default / solo / saved presets), optional
 * working directory (local path or user@host:path mounted over SSHFS) and
 * optional goal (a goal auto-starts the room). Reached from the + room tab or
 * /newroom.
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
  const [values, setValues] = useState<Record<TextKey, string>>({
    name: "",
    workspaceDir: "",
    goal: "",
  })
  const [presets, setPresets] = useState<PresetFile[]>([])
  const [presetIdx, setPresetIdx] = useState(DEFAULT_IDX)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [modelIdx, setModelIdx] = useState(0) // 0 = server default model
  const [focus, setFocus] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { rows } = useTerminalSize()

  useEffect(() => {
    api
      .presets()
      .then(setPresets)
      .catch(() => {})
    api
      .models()
      .then((r) => setModels(r.models))
      .catch(() => {})
  }, [api])

  const presetLabels = ["— default roster —", "— solo: pure pi —", ...presets.map((p) => p.name)]
  const soloSelected = presetIdx === SOLO_IDX
  const selectedPreset = presetIdx > SOLO_IDX ? presets[presetIdx - 2] : undefined
  const preset = selectedPreset?.name
  const modelLabels = ["— default model —", ...models.map((m) => `${m.local ? "🖥 " : "☁ "}${m.name}`)]
  const modelRef = modelIdx > 0 ? models[modelIdx - 1]?.ref : undefined

  // The Model row only exists in solo mode; focus indexes into this list, so
  // it renumbers automatically when the row appears/disappears (cycling the
  // roster happens while focus sits on the preset row, which keeps its index).
  const rowKeys: RowKey[] = [
    "name",
    "preset",
    ...(soloSelected ? (["model"] as RowKey[]) : []),
    "workspaceDir",
    "goal",
    "create",
  ]
  const focusKey = rowKeys[Math.min(focus, rowKeys.length - 1)]

  const submit = () => {
    if (busy) return
    const name = values.name.trim()
    // Solo rooms may go nameless — the server derives "solo/<model>".
    if (!name && !soloSelected) {
      setError("Name is required.")
      return
    }
    setBusy(true)
    api
      .createRoom({
        name,
        ...(soloSelected ? { solo: true, ...(modelRef ? { model: modelRef } : {}) } : preset ? { preset } : {}),
        ...(values.workspaceDir.trim() ? { workspaceDir: values.workspaceDir.trim() } : {}),
        ...(values.goal.trim() ? { goal: values.goal.trim() } : {}),
      })
      .then((room) => {
        onClose()
        // room.name, not the typed name — solo auto-names on empty input.
        onCreated(room.roomId, room.name, Boolean(values.goal.trim()))
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
      if (key.downArrow || key.tab) return setFocus((f) => Math.min(rowKeys.length - 1, f + 1))
      if (key.return) {
        if (focusKey === "create") return submit()
        return setFocus((f) => f + 1)
      }
      if (focusKey === "preset") {
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
      if (focusKey === "model") {
        const n = modelLabels.length
        if (key.leftArrow) {
          setError(null)
          setModelIdx((i) => (i - 1 + n) % n)
        }
        if (key.rightArrow) {
          setError(null)
          setModelIdx((i) => (i + 1) % n)
        }
        return
      }
      if (focusKey === "create") return
      const field = focusKey as TextKey
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

  const textRow = (rowKey: TextKey) => {
    const f = TEXT_FIELDS[rowKey]
    const focused = rowKey === focusKey
    const val = values[rowKey]
    const placeholder =
      rowKey === "name" && soloSelected ? "optional — auto-named solo/<model>" : f.placeholder
    return (
      <Box key={rowKey}>
        <Text color={focused ? "green" : undefined}>{focused ? "▶ " : "  "}</Text>
        <Text dimColor>{f.label}: </Text>
        {val ? (
          <Text wrap="truncate-end">
            {val}
            {focused ? <Text color="green">▌</Text> : null}
          </Text>
        ) : (
          <Text dimColor>{placeholder}</Text>
        )}
      </Box>
    )
  }

  const cycleRow = (focused: boolean, label: string, prefix: string, chosen: boolean, trailing?: string) => (
    <Box>
      <Text color={focused ? "green" : undefined}>{focused ? "▶ " : "  "}</Text>
      <Text dimColor>{prefix}: </Text>
      <Text color={chosen ? "cyan" : undefined} dimColor={!chosen}>
        {focused ? "‹ " : ""}
        {label}
        {focused ? " ›" : ""}
      </Text>
      {trailing ? <Text dimColor> {trailing}</Text> : null}
    </Box>
  )

  const presetFocused = focusKey === "preset"
  // Same per-agent preview as the Presets overlay (icon + name, model, tools)
  // so picking a preset here shows WHAT you're about to spawn, not just a name.
  const { shown, hidden } = previewPersonas(selectedPreset, roomFormPreviewMax(rows))
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Text color="green" bold>
        New room
      </Text>
      {textRow("name")}
      {cycleRow(
        presetFocused,
        presetLabels[presetIdx],
        "Preset",
        presetIdx !== DEFAULT_IDX,
        presets.length === 0 && !soloSelected
          ? "(no saved presets)"
          : selectedPreset
            ? ` ${presetSummary(selectedPreset)}`
            : undefined,
      )}
      {soloSelected ? (
        <>
          <Text dimColor>{"    a bare pi — full tools, no team scaffolding"}</Text>
          {cycleRow(focusKey === "model", modelLabels[modelIdx], "Model", modelIdx > 0)}
        </>
      ) : null}
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
      {textRow("workspaceDir")}
      {textRow("goal")}
      <Box marginTop={1}>
        <Text inverse={focusKey === "create"} color={focusKey === "create" ? "green" : "gray"}>
          {focusKey === "create" ? "▶ " : "  "}[ {busy ? "Creating…" : "Create room"} ]
        </Text>
      </Box>
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>
        {presetFocused ? "←→ roster · " : focusKey === "model" ? "←→ model · " : ""}↑↓ field · ⏎ next/create · esc
        cancel
      </Text>
    </Box>
  )
}
