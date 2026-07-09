import { Box, Text, useInput } from "ink"
import { useTerminalSize } from "../useTerminalSize"
import { useRef, useState } from "react"
import type { Message, Receipt, RosterItem, ToolActivity } from "@pipeline-moe/client-core"
import { renderMarkdownLines, renderStreamingMarkdownLines } from "../markdown"
import { summarizeArgs, TOOL_ICON, statusBadge } from "../activity"
import { headerRule, receiptLines } from "../transcript-format"

/**
 * The conversation view with line-accurate scrollback. Messages have wildly
 * varying heights (a planner reply can be 30+ lines), so windowing by *message*
 * would overflow the box and push the chrome off-screen. Instead we flatten
 * every message — and the in-flight streaming buffers — into a single list of
 * wrapped display lines, then render a terminal-height-bounded window over that
 * list. PgUp/PgDn scroll it; offset 0 pins to the bottom so live tokens stream
 * in. Agent messages render as markdown (pre-wrapped ANSI lines from
 * markdown.ts) — including in-flight streaming, which parses safely because
 * CommonMark runs an unclosed code fence to end-of-input and unclosed inline
 * markers stay literal until their closer streams in. User text stays raw.
 */

type Line = { text: string; color?: string; bold?: boolean; dim?: boolean; cursor?: boolean }

/** Word-wrap a block of text to `width` columns, preserving hard newlines and
 *  hard-splitting any single word longer than the width (e.g. a URL). */
function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const raw of text.split("\n")) {
    if (raw.length === 0) {
      out.push("")
      continue
    }
    let line = ""
    for (let word of raw.split(" ")) {
      while (word.length > width) {
        if (line) {
          out.push(line)
          line = ""
        }
        out.push(word.slice(0, width))
        word = word.slice(width)
      }
      if (!line) line = word
      else if (line.length + 1 + word.length <= width) line += " " + word
      else {
        out.push(line)
        line = word
      }
    }
    out.push(line)
  }
  return out
}

export function Transcript({
  messages,
  roster,
  streaming,
  liveReasoning,
  liveActivity,
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
  const [showThoughts, setShowThoughts] = useState(false)
  const [showTools, setShowTools] = useState(false)
  const maxOffsetRef = useRef(0)
  const pageRef = useRef(1)

  const cols = columns
  // Reserve rows for the status bar, command line, notices and borders so the
  // transcript never overflows its flex slot. One line is kept for the footer.
  const height = Math.max(4, rows - 8 - (reservedRows ?? 0))
  const bodyHeight = height - 1
  // Full terminal width minus padding margin (the roster is a horizontal
  // strip now, not a sidebar) — kept slightly short so Ink never re-wraps
  // our pre-wrapped lines.
  const width = Math.max(20, cols - 4)

  const byId = new Map(roster.map((r) => [r.id, r]))
  const colorOf = (author: string) =>
    author === "user" ? "white" : author === "shell" ? "yellow" : byId.get(author)?.color ?? "magenta"
  const nameOf = (author: string, fallback: string) =>
    author === "user" ? "You" : byId.get(author)?.name ?? fallback
  const iconOf = (author: string) =>
    author === "user" || author === "shell" ? undefined : byId.get(author)?.icon

  // Flatten the whole transcript into display lines.
  const lines: Line[] = []

  // The web UI's collapsible 💭 block: collapsed to one line by default
  // (reasoning traces can dwarf the reply), Ctrl+T expands them all. A live
  // trace shows its last lines so you can watch the agent think.
  const pushThought = (reasoning: string, live: boolean) => {
    const wrapped = wrap(reasoning.trim(), Math.max(10, width - 2))
    if (showThoughts) {
      lines.push({ text: live ? "💭 thinking…" : "💭 thought", dim: true })
      for (const l of wrapped) lines.push({ text: "  " + l, dim: true })
    } else if (live) {
      lines.push({ text: "💭 thinking…", dim: true })
      for (const l of wrapped.slice(-2)) lines.push({ text: "  " + l, dim: true })
    } else {
      lines.push({ text: `💭 thought (${wrapped.length} line${wrapped.length === 1 ? "" : "s"} · ctrl+t)`, dim: true })
    }
  }

  // ── Tool call activity ───────────────────────────────────────────────

  const pushActivity = (activity: ToolActivity[], live: boolean) => {
    if (activity.length === 0) return
    const hasRunning = live && activity.some((a) => a.status === "running")
    const suffix = hasRunning ? " · running…" : ""
    if (showTools || live) {
      // Expanded: header + one line per tool call
      lines.push({ text: `🔧 ${activity.length} tool ${activity.length === 1 ? "call" : "calls"}${suffix}`, dim: true })
      const argWidth = Math.max(10, width - 32) // leave room for icon + name + badge
      for (const a of activity) {
        const icon = TOOL_ICON[a.toolName] ?? "🔧"
        const args = summarizeArgs(a)
        const badge = statusBadge(a.status)
        const truncated = args.length > argWidth ? args.slice(0, argWidth - 1) + "…" : args
        const line = `  ${icon} ${a.toolName}${truncated ? " " + truncated : ""}  ${badge.text}`
        lines.push({ text: line, color: badge.color === "green" ? undefined : badge.color })
      }
    } else {
      // Collapsed: single summary line
      lines.push({ text: `🔧 ${activity.length} tool ${activity.length === 1 ? "call" : "calls"} · ctrl+o`, dim: true })
    }
  }

  for (const m of messages) {
    // Full-width rule in the author's color — the TUI counterpart of the
    // WebUI's per-reply card border; replaces the bare name line (no extra row).
    lines.push({ text: headerRule(nameOf(m.author, m.authorName), iconOf(m.author), width), bold: true, color: colorOf(m.author) })
    if (m.reasoning) pushThought(m.reasoning, false)
    if (m.activity?.length) pushActivity(m.activity, false)
    if (m.images?.length) lines.push({ text: `📎 ${m.images.length} image${m.images.length === 1 ? "" : "s"}`, dim: true })
    if (m.text) {
      // Shell output is raw text — markdown rendering would mangle it
      // (# comments become headers, indentation collapses).
      const rendered =
        m.author === "user" || m.author === "shell"
          ? wrap(m.text, width)
          : renderMarkdownLines(m.text, width) ?? wrap(m.text, width)
      for (const l of rendered) lines.push({ text: l })
    } else if (!m.question) lines.push({ text: "(no response)", dim: true })
    // ask_user callout — the WebUI shows this as a 🤚 banner under the bubble;
    // the TUI only surfaced the question in the status bar, so it vanished
    // from the story once answered. Options render dim so the scrollback
    // shows what was offered.
    if (m.question) {
      for (const l of wrap(`🤚 ${m.question}`, width)) lines.push({ text: l, color: "magenta" })
      for (const [i, o] of (m.questionOptions ?? []).entries()) {
        for (const l of wrap(`   ${i + 1} ${o}`, width)) lines.push({ text: l, dim: true })
      }
    }
    if (receipts[m.index]) for (const l of receiptLines(receipts[m.index])) lines.push(l)
    lines.push({ text: "" })
  }
  // Live blocks: an agent can be reasoning before its first text token, so
  // walk the union of both buffers.
  const liveIds = [...new Set([...Object.keys(streaming), ...Object.keys(liveReasoning), ...Object.keys(liveActivity)])]
  for (const id of liveIds) {
    const text = streaming[id] ?? ""
    const reasoning = liveReasoning[id] ?? ""
    const acts = liveActivity[id] ?? []
    if (!text && !reasoning && acts.length === 0) continue
    // width - 2 leaves room for the appended streaming cursor (" ▌") — a
    // full-width rule would push it past the truncate-end boundary.
    lines.push({ text: headerRule(nameOf(id, id), iconOf(id), width - 2), bold: true, color: colorOf(id), cursor: true })
    if (reasoning) pushThought(reasoning, !text)
    if (acts.length) pushActivity(acts, true)
    if (text) for (const l of renderStreamingMarkdownLines(text, width) ?? wrap(text, width)) lines.push({ text: l })
    lines.push({ text: "" })
  }

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
  const footer =
    lines.length > bodyHeight
      ? atBottom
        ? "⟨ PgUp to scroll back · ⌃↑ jump to top ⟩"
        : `⟨ ${effOffset} line${effOffset === 1 ? "" : "s"} below · PgDn to catch up · ⌃↓ jump to bottom ⟩`
      : ""

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
      <Text dimColor>{footer || " "}</Text>
    </Box>
  )
}
