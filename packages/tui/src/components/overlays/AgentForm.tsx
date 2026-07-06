import { Box, Text, useInput } from "ink"
import { useState } from "react"
import type { RoomStore } from "@pipeline-moe/client-core"

interface Field {
  key: "name" | "systemPrompt" | "tools" | "icon"
  label: string
  placeholder: string
}

const FIELDS: Field[] = [
  { key: "name", label: "Name", placeholder: "e.g. Reviewer" },
  { key: "systemPrompt", label: "System prompt", placeholder: "what this agent is for" },
  { key: "tools", label: "Tools", placeholder: "comma-separated, optional" },
  { key: "icon", label: "Icon", placeholder: "single emoji, optional" },
]

/**
 * Multi-field create-agent wizard. Up/down move between fields and the Create
 * action; typing edits the focused field. Submits via store.actions.create —
 * the server broadcasts the new roster, so no local roster write is needed.
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
    tools: "",
    icon: "",
  })
  const [focus, setFocus] = useState(0) // 0..FIELDS.length (last = Create button)
  const [error, setError] = useState<string | null>(null)
  const onCreate = focus === FIELDS.length

  const submit = () => {
    if (!values.name.trim() || !values.systemPrompt.trim()) {
      setError("Name and system prompt are required.")
      return
    }
    const tools = values.tools.trim()
      ? values.tools.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined
    store.actions
      .createParticipant({
        name: values.name.trim(),
        systemPrompt: values.systemPrompt.trim(),
        ...(tools ? { tools } : {}),
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
      if (key.downArrow || key.tab) return setFocus((f) => Math.min(FIELDS.length, f + 1))
      if (key.return) {
        if (onCreate) return submit()
        return setFocus((f) => Math.min(FIELDS.length, f + 1))
      }
      if (onCreate) return
      const field = FIELDS[focus].key
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

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Text color="green" bold>
        New agent
      </Text>
      {FIELDS.map((f, idx) => {
        const focused = idx === focus
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
      })}
      <Box marginTop={1}>
        <Text inverse={onCreate} color={onCreate ? "green" : "gray"}>
          {onCreate ? "▶ " : "  "}[ Create ]
        </Text>
      </Box>
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>↑↓ field · ⏎ next/create · esc cancel</Text>
    </Box>
  )
}
