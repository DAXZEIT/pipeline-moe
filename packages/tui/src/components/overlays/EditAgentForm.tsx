import { Box, Text, useInput } from "ink"
import { useEffect, useState } from "react"
import type { RoomStore } from "@pipeline-moe/client-core"
import { ALL_TOOLS } from "./AgentForm"
import { backspaceText } from "../../preset-composer"

// The web UI's color input is a free picker; a terminal wants a palette.
// The agent's current color is always slot 0, so "leave it alone" is easy.
const PALETTE = [
  "#6Fb3d2",
  "#5DCAA5",
  "#EF9F27",
  "#E06C75",
  "#C678DD",
  "#61AFEF",
  "#98C379",
  "#E5C07B",
  "#56B6C2",
  "#D19A66",
  "#F47FA4",
  "#888888",
]

const NAME_ROW = 0
const ICON_ROW = 1
const COLOR_ROW = 2
const TOOLS_ROW = 3
const SAVE_ROW = 4

/**
 * Edit an existing agent's identity — name, icon, color, tools — the TUI
 * counterpart of the web UI's "Edit persona" (model and thinking level have
 * their own commands, the system prompt has /prompt). Pre-filled from the
 * persona detail; Save PATCHes only identity fields, so nothing else moves.
 */
export function EditAgentForm({
  agentId,
  store,
  onClose,
  isActive,
}: {
  agentId: string
  store: RoomStore
  onClose: () => void
  isActive: boolean
}) {
  const [loaded, setLoaded] = useState(false)
  const [name, setName] = useState("")
  const [icon, setIcon] = useState("")
  const [colors, setColors] = useState<string[]>(PALETTE)
  const [colorIdx, setColorIdx] = useState(0)
  const [tools, setTools] = useState<string[]>([])
  const [toolCursor, setToolCursor] = useState(0)
  const [focus, setFocus] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    store.actions
      .getParticipant(agentId)
      .then((d) => {
        setName(d.name)
        setIcon(d.icon)
        // Current color first (deduped), palette after — index 0 = unchanged.
        setColors([d.color, ...PALETTE.filter((c) => c.toLowerCase() !== d.color.toLowerCase())])
        setColorIdx(0)
        setTools(d.tools)
        setLoaded(true)
      })
      .catch(() => setError("Failed to load the agent."))
  }, [store, agentId])

  const submit = () => {
    if (!name.trim()) {
      setError("Name is required.")
      return
    }
    store.actions
      .updateParticipant(agentId, {
        name: name.trim(),
        color: colors[colorIdx],
        tools,
        ...(icon.trim() ? { icon: icon.trim() } : {}),
      })
      .then(() => {
        store.pushNotice(`@${agentId} updated.`)
        onClose()
      })
      .catch((err: unknown) =>
        setError(err instanceof Error && err.message ? err.message : "Save failed — server unreachable?"),
      )
  }

  useInput(
    (input, key) => {
      if (key.escape) return onClose()
      if (!loaded) return
      if (key.upArrow) return setFocus((f) => Math.max(0, f - 1))
      if (key.downArrow || key.tab) return setFocus((f) => Math.min(SAVE_ROW, f + 1))
      if (key.return) {
        if (focus === SAVE_ROW) return submit()
        return setFocus((f) => f + 1)
      }
      if (focus === COLOR_ROW) {
        const n = colors.length
        if (key.leftArrow) setColorIdx((i) => (i - 1 + n) % n)
        if (key.rightArrow) setColorIdx((i) => (i + 1) % n)
        return
      }
      if (focus === TOOLS_ROW) {
        if (key.leftArrow) return setToolCursor((c) => (c - 1 + ALL_TOOLS.length) % ALL_TOOLS.length)
        if (key.rightArrow) return setToolCursor((c) => (c + 1) % ALL_TOOLS.length)
        if (input === " ") {
          const t = ALL_TOOLS[toolCursor]
          setError(null)
          setTools((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]))
        }
        return
      }
      if (focus === SAVE_ROW) return
      const set = focus === NAME_ROW ? setName : setIcon
      if (key.backspace || key.delete) {
        setError(null)
        // Code-point-safe: slice(0, -1) would split the emoji in Icon.
        set((v) => backspaceText(v))
        return
      }
      if (key.ctrl || key.meta) return
      if (input) {
        const clean = input.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "")
        if (clean) {
          setError(null)
          set((v) => v + clean)
        }
      }
    },
    { isActive },
  )

  const textRow = (row: number, label: string, val: string) => {
    const focused = row === focus
    return (
      <Box>
        <Text color={focused ? "green" : undefined}>{focused ? "▶ " : "  "}</Text>
        <Text dimColor>{label}: </Text>
        <Text>
          {val}
          {focused ? <Text color="green">▌</Text> : null}
        </Text>
      </Box>
    )
  }

  const colorFocused = focus === COLOR_ROW
  const toolsFocused = focus === TOOLS_ROW
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Text color="green" bold>
        Edit agent · @{agentId}
      </Text>
      {!loaded && !error ? <Text dimColor>Loading…</Text> : null}
      {loaded ? (
        <>
          {textRow(NAME_ROW, "Name", name)}
          {textRow(ICON_ROW, "Icon", icon)}
          <Box>
            <Text color={colorFocused ? "green" : undefined}>{colorFocused ? "▶ " : "  "}</Text>
            <Text dimColor>Color: </Text>
            <Text color={colors[colorIdx]}>
              {colorFocused ? "‹ " : ""}■■ {colors[colorIdx]}
              {colorIdx === 0 ? " (current)" : ""}
              {colorFocused ? " ›" : ""}
            </Text>
          </Box>
          <Box>
            <Text color={toolsFocused ? "green" : undefined}>{toolsFocused ? "▶ " : "  "}</Text>
            <Text dimColor>Tools: </Text>
            <Box flexWrap="wrap" flexGrow={1}>
              {ALL_TOOLS.map((t, i) => {
                const on = tools.includes(t)
                const cur = toolsFocused && i === toolCursor
                return (
                  <Text key={t} inverse={cur} color={on ? "green" : undefined} dimColor={!on && !cur}>
                    {on ? "■" : "□"}
                    {t}
                    {"  "}
                  </Text>
                )
              })}
            </Box>
          </Box>
          <Box marginTop={1}>
            <Text inverse={focus === SAVE_ROW} color={focus === SAVE_ROW ? "green" : "gray"}>
              {focus === SAVE_ROW ? "▶ " : "  "}[ Save ]
            </Text>
          </Box>
        </>
      ) : null}
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>
        {colorFocused ? "←→ color · " : ""}
        {toolsFocused ? "←→ tool · space toggle · " : ""}
        ↑↓ field · ⏎ next/save · esc cancel
      </Text>
    </Box>
  )
}
