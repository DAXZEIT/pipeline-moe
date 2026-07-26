import { Box, Text, useInput } from "ink"
import { appendFileSync } from "node:fs"
import { useTerminalSize } from "../useTerminalSize"
import { useRef, useState } from "react"
import type { LivePart, Message, Receipt, RosterItem, ToolActivity } from "@pipeline-moe/client-core"
import { transcriptLines } from "../transcript-lines"

/**
 * The conversation view with line-accurate scrollback, for the Ink client.
 *
 * The flatten itself lives in `../transcript-lines.ts` and is shared with the
 * pi-tui client — same messages, same wrapping, same thought gutter, same
 * chronological segments. What is left here is everything Ink-specific and
 * everything the OTHER client deliberately does not have: a window over the
 * line list, its offset, and the keys that move it.
 *
 * Windowing by *message* would overflow the box (a planner reply can be 30+
 * lines) and push the chrome off-screen, so we window by display line: offset 0
 * pins to the bottom so live tokens stream in, PgUp/PgDn move it.
 */

export function Transcript({
  messages,
  roster,
  streaming,
  liveReasoning,
  liveActivity,
  liveParts,
  reasoningActive,
  receipts,
  reservedRows,
  isActive,
  scrollRef,
}: {
  messages: Message[]
  roster: RosterItem[]
  streaming: Record<string, string>
  liveReasoning: Record<string, string>
  liveActivity: Record<string, ToolActivity[]>
  /** The in-flight turn in chronological order, assembled from the `seq` the
   *  server stamps on every frame. Absent for a server that predates it. */
  liveParts?: Record<string, LivePart[]>
  /** True while the agent's most recent delta was reasoning. */
  reasoningActive: Record<string, boolean>
  /** Filesystem-verified work receipts, keyed by owning message index. */
  receipts: Record<number, Receipt>
  /** Extra terminal rows currently claimed below the transcript (e.g. the QCM
   *  answer picker) beyond the fixed chrome. Without this the total layout
   *  exceeds the screen and Ink's row diffing corrupts — rows vanish and
   *  leave glyph fragments behind. */
  reservedRows?: number
  isActive: boolean
  /** Receives a line scroller (+up / −down) — driven by ↑/↓ from the command
   *  line, which is what the mouse wheel sends in alternate-scroll mode. */
  scrollRef?: React.MutableRefObject<(delta: number) => void>
}) {
  const { rows, columns } = useTerminalSize()
  const [offset, setOffset] = useState(0) // display lines scrolled up from the bottom
  // Thoughts are shown in full by default. The interleaved layout is what
  // changed the balance: a thought is no longer one wall glued to the top of
  // the turn, it is the sentence that explains the tool call under it, and
  // collapsed it explains nothing. Ctrl+T now COLLAPSES (dax, 2026-07-26).
  const [showThoughts, setShowThoughts] = useState(true)
  const [showTools, setShowTools] = useState(false)
  const maxOffsetRef = useRef(0)
  const pageRef = useRef(1)

  const cols = columns
  // Reserve rows for the status bar, command line, notices and borders so the
  // transcript never overflows its flex slot. One line is kept for the footer.
  const height = Math.max(4, rows - 8 - (reservedRows ?? 0))
  if (process.env.PMOE_LAYOUT_LOG) {
    try {
      appendFileSync(process.env.PMOE_LAYOUT_LOG, `transcript rows=${rows} reserved=${reservedRows} height=${height}\n`)
    } catch {}
  }
  const bodyHeight = height - 1
  // Full terminal width minus padding margin (the roster is a horizontal
  // strip now, not a sidebar) — kept slightly short so Ink never re-wraps
  // our pre-wrapped lines.
  const width = Math.max(20, cols - 4)

  const { lines, hasThoughts } = transcriptLines(
    { messages, roster, streaming, liveReasoning, liveActivity, liveParts, reasoningActive, receipts },
    width,
    { showThoughts, showTools },
  )

  const maxOffset = Math.max(0, lines.length - bodyHeight)
  const effOffset = Math.min(offset, maxOffset)
  maxOffsetRef.current = maxOffset
  pageRef.current = Math.max(1, bodyHeight - 1)
  if (scrollRef)
    scrollRef.current = (delta) =>
      setOffset((o) => Math.max(0, Math.min(maxOffsetRef.current, o + delta)))

  const end = lines.length - effOffset
  const start = Math.max(0, end - bodyHeight)
  const visible = lines.slice(start, end)

  useInput(
    (input, key) => {
      if (key.pageUp) setOffset((o) => Math.min(maxOffsetRef.current, o + pageRef.current))
      else if (key.pageDown) setOffset((o) => Math.max(0, o - pageRef.current))
      // Ctrl+↑/↓ jump to the very top/bottom in one press — paging through a
      // long resumed conversation line-by-line is painfully slow otherwise.
      else if (key.ctrl && key.upArrow) setOffset(maxOffsetRef.current)
      else if (key.ctrl && key.downArrow) setOffset(0)
      // Ctrl+T toggles thought expansion; the command line ignores ctrl-chords.
      else if (key.ctrl && input === "t") setShowThoughts((s) => !s)
      // Ctrl+O toggles tool call activity expansion.
      else if (key.ctrl && input === "o") setShowTools((s) => !s)
    },
    { isActive },
  )

  const atBottom = effOffset === 0
  const scrollHint =
    lines.length > bodyHeight
      ? atBottom
        ? "⟨ PgUp to scroll back · ⌃↑ jump to top ⟩"
        : `⟨ ${effOffset} line${effOffset === 1 ? "" : "s"} below · PgDn to catch up · ⌃↓ jump to bottom ⟩`
      : ""
  // Thoughts are expanded by default, so the only way to learn the key is to
  // be told. Stated as the ACTION the key performs, not as a state name.
  const thoughtHint = hasThoughts ? (showThoughts ? "⌃T fold thoughts" : "⌃T unfold thoughts") : ""
  const footer = [scrollHint, thoughtHint].filter(Boolean).join("  ")

  return (
    <Box flexDirection="column" flexGrow={1}>
      {visible.map((l, i) => (
        // truncate-end guarantees one display line per entry even when a
        // non-reflowable markdown block (code, table) exceeds the width —
        // Ink re-wrapping it would silently break the line accounting.
        <Text key={start + i} bold={l.bold} color={l.color} dimColor={l.dim} wrap="truncate-end">
          {l.text || " "}
          {l.cursor ? <Text color="yellow"> ▌</Text> : null}
        </Text>
      ))}
      <Box flexGrow={1} />
      {/* truncate-end for the same reason the body lines use it: a footer that
          wraps to two rows would silently break the line accounting. */}
      <Text dimColor wrap="truncate-end">{footer || " "}</Text>
    </Box>
  )
}
