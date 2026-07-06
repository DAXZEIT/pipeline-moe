import { Box, Text, useInput } from "ink"
import { useState } from "react"
import type { RoomStore } from "@pipeline-moe/client-core"

// Everything the server's parsePersona accepts (src/validation.ts VALID_TOOLS)
// — the web UI's chip row shows only the first seven, but the web tools are
// just as valid, so the TUI offers the full set.
const ALL_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "web_search",
  "web_read",
  "youtube_transcript",
  "arxiv_search",
  "youcom_search",
]
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"]

interface Field {
  key: "name" | "systemPrompt" | "icon"
  label: string
  placeholder: string
}

const NAME_ROW = 0
const PROMPT_ROW = 1
const TOOLS_ROW = 2
const ICON_ROW = 3
const CREATE_ROW = 4

const TEXT_FIELDS: Record<number, Field> = {
  [NAME_ROW]: { key: "name", label: "Name", placeholder: "e.g. Reviewer" },
  [PROMPT_ROW]: { key: "systemPrompt", label: "System prompt", placeholder: "what this agent is for" },
  [ICON_ROW]: { key: "icon", label: "Icon", placeholder: "single emoji, optional" },
}

/**
 * Multi-field create-agent wizard. Up/down move between rows and the Create
 * action; typing edits the focused text field. The Tools row is a chip
 * toggle (the web UI's checkbox chips): left/right pick a tool, space flips
 * it. Submits via store.actions.createParticipant — the server broadcasts the
 * new roster, so no local roster write is needed.
 */
export function AgentForm({
  store,
  onClose,
  isActive,
}: {
  store: RoomStore
  onClose: () => void
  isActive: boolean
}) {
  const [values, setValues] = useState<Record<Field["key"], string>>({
    name: "",
    systemPrompt: "",
    icon: "",
  })
  const [tools, setTools] = useState<string[]>(DEFAULT_TOOLS)
  const [toolCursor, setToolCursor] = useState(0)
  const [focus, setFocus] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    if (!values.name.trim() || !values.systemPrompt.trim()) {
      setError("Name and system prompt are required.")
      return
    }
    store.actions
      .createParticipant({
        name: values.name.trim(),
        systemPrompt: values.systemPrompt.trim(),
        tools,
        ...(values.icon.trim() ? { icon: values.icon.trim() } : {}),
      })
      .then(() => {
        store.pushNotice(`Agent "${values.name.trim()}" created.`)
        onClose()
      })
      // Surface the failure in the form itself — a swallowed rejection leaves
      // Create looking like it did nothing at all.
      .catch((err: unknown) =>
        setError(err instanceof Error && err.message ? err.message : "Create failed — server unreachable?"),
      )
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
        // embedded — raw control characters shred the box layout, so flatten
        // newlines to spaces and drop the rest.
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
          <Text>
            {val}
            {focused ? <Text color="green">▌</Text> : null}
          </Text>
        ) : (
          <Text dimColor>{f.placeholder}</Text>
        )}
      </Box>
    )
  }

  const toolsFocused = focus === TOOLS_ROW
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Text color="green" bold>
        New agent
      </Text>
      {textRow(NAME_ROW)}
      {textRow(PROMPT_ROW)}
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
      {textRow(ICON_ROW)}
      <Box marginTop={1}>
        <Text inverse={focus === CREATE_ROW} color={focus === CREATE_ROW ? "green" : "gray"}>
          {focus === CREATE_ROW ? "▶ " : "  "}[ Create ]
        </Text>
      </Box>
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>
        {toolsFocused ? "←→ tool · space toggle · " : ""}↑↓ field · ⏎ next/create · esc cancel
      </Text>
    </Box>
  )
}
