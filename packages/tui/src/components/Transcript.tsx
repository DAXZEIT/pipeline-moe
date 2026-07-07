import { Box, Text, useInput } from "ink"
import { useTerminalSize } from "../useTerminalSize"
import { useRef, useState } from "react"
import type { Message, RosterItem } from "@pipeline-moe/client-core"
import { renderMarkdownLines, renderStreamingMarkdownLines } from "../markdown"

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
  isActive,
  scrollRef,
}: {
  messages: Message[]
  roster: RosterItem[]
  streaming: Record<string, string>
  liveReasoning: Record<string, string>
  isActive: boolean
  /** Receives a line scroller (+up / −down) — driven by ↑/↓ from the command
   *  line, which is what the mouse wheel sends in alternate-scroll mode. */
  scrollRef?: React.MutableRefObject<(delta: number) => void>
}) {
  const { rows, columns } = useTerminalSize()
  const [offset, setOffset] = useState(0) // display lines scrolled up from the bottom
  const [showThoughts, setShowThoughts] = useState(false)
  const maxOffsetRef = useRef(0)
  const pageRef = useRef(1)

  const cols = columns
  // Reserve rows for the status bar, command line, notices and borders so the
  // transcript never overflows its flex slot. One line is kept for the footer.
  const height = Math.max(4, rows - 8)
  const bodyHeight = height - 1
  // Roster is 26 wide; leave margin so Ink doesn't re-wrap our pre-wrapped lines.
  const width = Math.max(20, cols - 30)

  const byId = new Map(roster.map((r) => [r.id, r]))
  const colorOf = (author: string) =>
    author === "user" ? "white" : author === "shell" ? "yellow" : byId.get(author)?.color ?? "magenta"
  const nameOf = (author: string, fallback: string) =>
    author === "user" ? "You" : byId.get(author)?.name ?? fallback

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

  for (const m of messages) {
    lines.push({ text: nameOf(m.author, m.authorName), bold: true, color: colorOf(m.author) })
    if (m.reasoning) pushThought(m.reasoning, false)
    if (m.text) {
      // Shell output is raw text — markdown rendering would mangle it
      // (# comments become headers, indentation collapses).
      const rendered =
        m.author === "user" || m.author === "shell"
          ? wrap(m.text, width)
          : renderMarkdownLines(m.text, width) ?? wrap(m.text, width)
      for (const l of rendered) lines.push({ text: l })
    } else lines.push({ text: "(no response)", dim: true })
    lines.push({ text: "" })
  }
  // Live blocks: an agent can be reasoning before its first text token, so
  // walk the union of both buffers.
  const liveIds = [...new Set([...Object.keys(streaming), ...Object.keys(liveReasoning)])]
  for (const id of liveIds) {
    const text = streaming[id] ?? ""
    const reasoning = liveReasoning[id] ?? ""
    if (!text && !reasoning) continue
    lines.push({ text: nameOf(id, id), bold: true, color: colorOf(id), cursor: true })
    if (reasoning) pushThought(reasoning, !text)
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
      // Ctrl+T toggles thought expansion; the command line ignores ctrl-chords.
      else if (key.ctrl && input === "t") setShowThoughts((s) => !s)
    },
    { isActive },
  )

  const atBottom = effOffset === 0
  const footer =
    lines.length > bodyHeight
      ? atBottom
        ? "⟨ PgUp to scroll back ⟩"
        : `⟨ ${effOffset} line${effOffset === 1 ? "" : "s"} below · PgDn to catch up ⟩`
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
