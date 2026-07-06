import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Box, Text, useInput, useStdin } from "ink"
import { useEffect, useRef, useState } from "react"
import type { RoomStore, PersonaDetail } from "@pipeline-moe/client-core"
import { useTerminalSize } from "../../useTerminalSize"

/** Pick the user's editor: $VISUAL, $EDITOR, then common fallbacks. */
function resolveEditor(): string {
  if (process.env.VISUAL) return process.env.VISUAL
  if (process.env.EDITOR) return process.env.EDITOR
  for (const candidate of ["nvim", "vim", "nano", "vi"]) {
    const found = spawnSync("sh", ["-c", `command -v ${candidate}`], { stdio: "ignore" })
    if (found.status === 0) return candidate
  }
  return "vi"
}

/**
 * View + edit an agent's system prompt. The view is a scrollable pager;
 * pressing `e` hands the prompt to the user's $EDITOR in a temp .md file —
 * multi-line editing in a TUI input line is hopeless, the external editor is
 * the terminal-native answer (same pattern as `git commit`). spawnSync blocks
 * the event loop, so Ink can't repaint over the editor; raw mode is released
 * around it and the editor owns the tty via stdio: "inherit".
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
    const dir = mkdtempSync(join(tmpdir(), "pmoe-prompt-"))
    const file = join(dir, `${agentId}.md`)
    try {
      writeFileSync(file, detail.systemPrompt)
      setRawMode(false)
      const editor = resolveEditor()
      // $EDITOR may carry arguments ("code --wait") — run through the shell.
      const res = spawnSync("sh", ["-c", `${editor} "$0"`, file], { stdio: "inherit" })
      setRawMode(true)
      if (res.error) {
        setError(`Editor failed: ${String(res.error.message ?? res.error)}`)
        return
      }
      const next = readFileSync(file, "utf-8")
      if (next.trim() === detail.systemPrompt.trim()) {
        store.pushNotice("System prompt unchanged.")
        return
      }
      if (!next.trim()) {
        setError("Empty prompt — not saved.")
        return
      }
      store.actions
        .updateParticipant(agentId, { systemPrompt: next.trim() })
        .then(() => {
          store.pushNotice(`@${agentId} system prompt updated.`)
          onClose()
        })
        .catch((err: unknown) =>
          setError(err instanceof Error && err.message ? err.message : "Save failed."),
        )
    } finally {
      editingRef.current = false
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
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
