import { Box, Text, useInput, useStdout } from "ink"
import { useRef, useState } from "react"
import type { Message, RosterItem } from "@pipeline-moe/client-core"

/**
 * The conversation view with line-accurate scrollback. Messages have wildly
 * varying heights (a planner reply can be 30+ lines), so windowing by *message*
 * would overflow the box and push the chrome off-screen. Instead we flatten
 * every message — and the in-flight streaming buffers — into a single list of
 * wrapped display lines, then render a terminal-height-bounded window over that
 * list. PgUp/PgDn scroll it; offset 0 pins to the bottom so live tokens stream
 * in. Markdown is rendered raw for now — terminal markdown is a follow-up.
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
  isActive,
}: {
  messages: Message[]
  roster: RosterItem[]
  streaming: Record<string, string>
  isActive: boolean
}) {
  const { stdout } = useStdout()
  const [offset, setOffset] = useState(0) // display lines scrolled up from the bottom
  const maxOffsetRef = useRef(0)
  const pageRef = useRef(1)

  const rows = stdout?.rows ?? 24
  const cols = stdout?.columns ?? 80
  // Reserve rows for the status bar, command line, notices and borders so the
  // transcript never overflows its flex slot. One line is kept for the footer.
  const height = Math.max(4, rows - 8)
  const bodyHeight = height - 1
  // Roster is 26 wide; leave margin so Ink doesn't re-wrap our pre-wrapped lines.
  const width = Math.max(20, cols - 30)

  const byId = new Map(roster.map((r) => [r.id, r]))
  const colorOf = (author: string) => (author === "user" ? "white" : byId.get(author)?.color ?? "magenta")
  const nameOf = (author: string, fallback: string) =>
    author === "user" ? "You" : byId.get(author)?.name ?? fallback

  // Flatten the whole transcript into display lines.
  const lines: Line[] = []
  for (const m of messages) {
    lines.push({ text: nameOf(m.author, m.authorName), bold: true, color: colorOf(m.author) })
    if (m.text) for (const l of wrap(m.text, width)) lines.push({ text: l })
    else lines.push({ text: "(no response)", dim: true })
    lines.push({ text: "" })
  }
  for (const [id, text] of Object.entries(streaming)) {
    if (!text) continue
    lines.push({ text: nameOf(id, id), bold: true, color: colorOf(id), cursor: true })
    for (const l of wrap(text, width)) lines.push({ text: l })
    lines.push({ text: "" })
  }

  const maxOffset = Math.max(0, lines.length - bodyHeight)
  const effOffset = Math.min(offset, maxOffset)
  maxOffsetRef.current = maxOffset
  pageRef.current = Math.max(1, bodyHeight - 1)

  const end = lines.length - effOffset
  const start = Math.max(0, end - bodyHeight)
  const visible = lines.slice(start, end)

  useInput(
    (_input, key) => {
      if (key.pageUp) setOffset((o) => Math.min(maxOffsetRef.current, o + pageRef.current))
      else if (key.pageDown) setOffset((o) => Math.max(0, o - pageRef.current))
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
        <Text key={start + i} bold={l.bold} color={l.color} dimColor={l.dim}>
          {l.text || " "}
          {l.cursor ? <Text color="yellow"> ▌</Text> : null}
        </Text>
      ))}
      <Box flexGrow={1} />
      <Text dimColor>{footer || " "}</Text>
    </Box>
  )
}
