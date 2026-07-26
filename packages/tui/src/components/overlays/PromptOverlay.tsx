import { Box, Text, useInput, useStdin } from "ink"
import { useEffect, useRef, useState } from "react"
import type { RoomStore, PersonaDetail } from "@pipeline-moe/client-core"
import { useTerminalSize } from "../../useTerminalSize"
import { editText } from "../../external-editor"

/**
 * View + edit an agent's system prompt. The view is a scrollable pager;
 * pressing `e` hands the prompt to the user's $EDITOR in a temp .md file —
 * multi-line editing in a TUI input line is hopeless, the external editor is
 * the terminal-native answer (same pattern as `git commit`). The temp-file
 * dance lives in `external-editor.ts`, shared with the pi-tui client; what is
 * local is HOW the terminal is released — Ink drops raw mode around the
 * blocking spawn, and the editor owns the tty via stdio: "inherit".
 */
export function PromptOverlay({
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
  const { rows, columns } = useTerminalSize()
  const { setRawMode } = useStdin()
  const [detail, setDetail] = useState<PersonaDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scroll, setScroll] = useState(0)
  const editingRef = useRef(false)

  useEffect(() => {
    store.actions
      .getParticipant(agentId)
      .then(setDetail)
      .catch(() => setError("Failed to load the agent."))
  }, [store, agentId])

  const openEditor = () => {
    if (!detail || editingRef.current) return
    editingRef.current = true
    try {
      const outcome = editText(detail.systemPrompt, {
        basename: `${agentId}.md`,
        suspend: (run) => {
          setRawMode(false)
          run()
          setRawMode(true)
        },
      })
      if (outcome.kind === "unchanged") return store.pushNotice("System prompt unchanged.")
      if (outcome.kind === "empty") return setError("Empty prompt — not saved.")
      if (outcome.kind === "failed") return setError(`Editor failed: ${outcome.error}`)
      store.actions
        .updateParticipant(agentId, { systemPrompt: outcome.text })
        .then(() => {
          store.pushNotice(`@${agentId} system prompt updated.`)
          onClose()
        })
        .catch((err: unknown) =>
          setError(err instanceof Error && err.message ? err.message : "Save failed."),
        )
    } finally {
      editingRef.current = false
    }
  }

  const promptLines = detail ? detail.systemPrompt.split("\n") : []
  // Cap the pager so the surrounding chrome always stays on screen.
  const pageSize = Math.max(4, Math.min(16, rows - 12))
  const maxScroll = Math.max(0, promptLines.length - pageSize)
  const at = Math.min(scroll, maxScroll)
  const visible = promptLines.slice(at, at + pageSize)

  useInput(
    (input, key) => {
      if (key.escape) return onClose()
      if (input === "e") return openEditor()
      if (key.upArrow) return setScroll((s) => Math.max(0, s - 1))
      if (key.downArrow) return setScroll((s) => Math.min(maxScroll, s + 1))
      if (key.pageUp) return setScroll((s) => Math.max(0, s - pageSize))
      if (key.pageDown) return setScroll((s) => Math.min(maxScroll, s + pageSize))
    },
    { isActive },
  )

  const width = Math.max(20, columns - 8)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta" bold>
        System prompt · {detail ? `${detail.icon} ${detail.name}` : agentId}
        {promptLines.length > pageSize ? (
          <Text dimColor>{`  ${at + 1}-${Math.min(at + pageSize, promptLines.length)}/${promptLines.length}`}</Text>
        ) : null}
      </Text>
      {!detail && !error ? <Text dimColor>Loading…</Text> : null}
      {visible.map((l, i) => (
        <Text key={at + i} wrap="truncate-end">
          {l.slice(0, width) || " "}
        </Text>
      ))}
      {maxScroll > 0 && at < maxScroll ? <Text dimColor>  ▼ more</Text> : null}
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>↑↓ scroll · e edit in $EDITOR · esc close</Text>
    </Box>
  )
}
