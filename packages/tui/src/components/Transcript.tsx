import { Box, Text, useInput } from "ink"
import { appendFileSync } from "node:fs"
import { useTerminalSize } from "../useTerminalSize"
import { useRef, useState } from "react"
import type { LivePart, Message, Receipt, RosterItem, ToolActivity } from "@pipeline-moe/client-core"
import { renderMarkdownLines, renderStreamingMarkdownLines } from "../markdown"
import { groupActivity, groupLine, windowActivity, type ActivityGroup } from "../activity"
import { toSegments, windowSequence, type DisplaySegment } from "../parts"
import { fmtDuration, headerRule, receiptLines } from "../transcript-format"

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
   *  server stamps on every frame. Absent for a server that predates it, which
   *  is exactly when the grouped live block below still applies. */
  liveParts?: Record<string, LivePart[]>
  /** True while the agent's most recent delta was reasoning — a second
   *  thinking burst after text/tools re-shows "💭 thinking…" instead of
   *  silently growing the collapsed thought block. */
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
  const [showThoughts, setShowThoughts] = useState(false)
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
    const errors = activity.filter((a) => a.status === "error").length
    const count = `🔧 ${activity.length} tool ${activity.length === 1 ? "call" : "calls"}`
    const errSuffix = errors ? ` · ${errors} ✗` : ""
    const runSuffix = hasRunning ? " · running…" : ""
    const argWidth = Math.max(10, width - 32) // leave room for icon + name + badge
    const pushGroup = (g: ActivityGroup) => {
      const l = groupLine(g, argWidth)
      lines.push({ text: l.text, color: l.color === "green" ? undefined : l.color })
    }
    if (showTools) {
      // Fully expanded (ctrl+o): one line per call, no aggregation.
      lines.push({ text: `${count}${errSuffix}${runSuffix}`, dim: true })
      for (const a of activity) pushGroup({ toolName: a.toolName, items: [a], status: a.status })
    } else if (live) {
      // Live window: ×N-aggregated groups, last LIVE_WINDOW only — a 100-call
      // turn otherwise floods the transcript. Errors that scrolled past the
      // window stay pinned above it; the header carries the full count.
      const { pinnedErrors, visible, hiddenCalls } = windowActivity(groupActivity(activity))
      const hidden = hiddenCalls ? ` · ${hiddenCalls} earlier · ctrl+o` : ""
      lines.push({ text: `${count}${errSuffix}${hidden}${runSuffix}`, dim: true })
      for (const g of pinnedErrors) pushGroup(g)
      if (hiddenCalls) lines.push({ text: "  ⋯", dim: true })
      for (const g of visible) pushGroup(g)
    } else {
      // Collapsed: single summary line (errors stay visible even collapsed)
      lines.push({ text: `${count}${errSuffix} · ctrl+o`, dim: true })
    }
  }

  // ── Interleaved sequence (docs/interleaved-turns.md) ─────────────────
  //
  // The chronological path. Everything above stays as the fallback: a turn
  // recorded before the server segmented it has no `parts`, and there are 67 M
  // of those in sessions/.

  /** One reasoning segment. Collapsed it is a single line carrying its WRAPPED
   *  length — the count is measured here, at the only place that knows the
   *  width, which is why no line count is stored on the part. */
  const pushReasoningSegment = (content: string, live: boolean) => {
    const wrapped = wrap(content, Math.max(10, width - 2))
    if (showThoughts) {
      lines.push({ text: live ? "💭 thinking…" : "💭 thought", dim: true })
      for (const l of wrapped) lines.push({ text: "  " + l, dim: true })
    } else if (live) {
      // The tail of a thought in flight, so you can watch it move.
      lines.push({ text: "💭 thinking…", dim: true })
      for (const l of wrapped.slice(-2)) lines.push({ text: "  " + l, dim: true })
    } else {
      lines.push({ text: `💭 ${wrapped.length} line${wrapped.length === 1 ? "" : "s"} · ctrl+t`, dim: true })
    }
  }

  const pushSegment = (s: DisplaySegment, live: boolean, argWidth: number) => {
    if (s.kind === "tools") {
      const l = groupLine(s.group, argWidth)
      lines.push({ text: l.text, color: l.color === "green" ? undefined : l.color })
    } else if (s.kind === "reasoning") {
      pushReasoningSegment(s.content, live)
    } else {
      const rendered = live
        ? renderStreamingMarkdownLines(s.content, width) ?? wrap(s.content, width)
        : renderMarkdownLines(s.content, width) ?? wrap(s.content, width)
      for (const l of rendered) lines.push({ text: l })
    }
  }

  /** Draw a turn in the order it happened. Returns false when there is nothing
   *  to draw, so the caller can fall back to the grouped layout. */
  const pushSequence = (
    parts: readonly { type: "reasoning" | "text" | "tool"; content?: string; toolCallId?: string }[],
    activity: ToolActivity[] | undefined,
    live: boolean,
  ): boolean => {
    const segments = toSegments(parts as never, activity)
    if (segments.length === 0) return false
    const argWidth = Math.max(10, width - 32)
    // Only the LAST segment of a running turn is in flight. Marking them all
    // live would re-open "💭 thinking…" on every thought the turn ever had.
    const inFlight = segments[segments.length - 1]
    const draw = (s: DisplaySegment) => pushSegment(s, live && s === inFlight, argWidth)
    // ctrl+o expands the sequence, the same key that expands a tool block —
    // both are "show me everything that got folded away".
    if (showTools) {
      for (const s of segments) draw(s)
      return true
    }
    const { head, pinnedErrors, hidden, tail } = windowSequence(segments)
    for (const s of head) draw(s)
    for (const s of pinnedErrors) draw(s)
    if (hidden > 0) lines.push({ text: `  ⋯ ${hidden} segment${hidden === 1 ? "" : "s"} hidden · ctrl+o`, dim: true })
    for (const s of tail) draw(s)
    return true
  }

  for (const m of messages) {
    // Full-width rule in the author's color — the TUI counterpart of the
    // WebUI's per-reply card border; replaces the bare name line (no extra row).
    lines.push({
      text: headerRule(nameOf(m.author, m.authorName), iconOf(m.author), width, m.durationMs != null ? fmtDuration(m.durationMs) : undefined),
      bold: true,
      color: colorOf(m.author),
    })
    // Chronological when the entry carries it; grouped otherwise.
    const interleaved = m.parts?.length ? pushSequence(m.parts, m.activity, false) : false
    if (!interleaved) {
      if (m.reasoning) pushThought(m.reasoning, false)
      if (m.activity?.length) pushActivity(m.activity, false)
    }
    if (m.images?.length) lines.push({ text: `📎 ${m.images.length} image${m.images.length === 1 ? "" : "s"}`, dim: true })
    // With a sequence, the model's prose was already drawn in place, as text
    // segments. `m.text` is then a COMPOSED body (the reply plus whatever
    // turnBody added) and re-rendering it would duplicate the reply. The one
    // case it must still be drawn is a turn that wrote no prose at all, where
    // the body IS turnBody's placeholder — "(tool calls only — no text reply)"
    // and, on a salvaged turn, its marker.
    const proseDrawn = interleaved && m.parts!.some((p) => p.type === "text")
    if (m.text && !proseDrawn) {
      // Shell output is raw text — markdown rendering would mangle it
      // (# comments become headers, indentation collapses).
      const rendered =
        m.author === "user" || m.author === "shell"
          ? wrap(m.text, width)
          : renderMarkdownLines(m.text, width) ?? wrap(m.text, width)
      for (const l of rendered) lines.push({ text: l })
    } else if (!proseDrawn && !m.question) lines.push({ text: "(no response)", dim: true })
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
    // Routing decision footer — a tool-only handoff is invisible in the reply
    // text, and the next agent otherwise appears to take over at random
    // (observed live: tester silently handed to scribe twice, 2026-07-10).
    if (m.handoffTo) {
      lines.push({ text: `↪ handoff → @${m.handoffTo}`, dim: true })
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
    const parts = liveParts?.[id]
    if (!text && !reasoning && acts.length === 0) continue
    // width - 2 leaves room for the appended streaming cursor (" ▌") — a
    // full-width rule would push it past the truncate-end boundary.
    lines.push({ text: headerRule(nameOf(id, id), iconOf(id), width - 2), bold: true, color: colorOf(id), cursor: true })
    // Live = the agent is thinking RIGHT NOW (last delta was reasoning) — not
    // "no text yet": a second burst after text/tools re-opens "thinking…"
    // instead of silently growing the collapsed thought block.
    // The live sequence is the SAME sequence the entry will carry — the server
    // stamped the boundaries, so the turn does not visibly re-order when the
    // message lands (verified live, 2026-07-25: 9 segments assembled from the
    // stream, 9 persisted, identical).
    if (!(parts?.length && pushSequence(parts, acts, true))) {
      if (reasoning) pushThought(reasoning, reasoningActive[id] ?? !text)
      if (acts.length) pushActivity(acts, true)
      if (text) for (const l of renderStreamingMarkdownLines(text, width) ?? wrap(text, width)) lines.push({ text: l })
    }
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
