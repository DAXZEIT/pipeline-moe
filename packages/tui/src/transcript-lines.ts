// The conversation, flattened to display lines. NO rendering framework.
//
// This is the body of what `Transcript.tsx` used to be, with React removed. It
// was always a `render(width): string[]` — Ink was only painting the result —
// and now it is one literally, which is what lets two clients (Ink and pi-tui)
// show the identical transcript without either owning it.
//
// Messages have wildly varying heights (a planner reply can be 30+ lines), so
// windowing by *message* would overflow any box. Everything — persisted
// messages and the in-flight streaming buffers — flattens into one list of
// wrapped lines, and the CALLER decides what to do with it: the Ink client
// slices a terminal-height window, the pi-tui client returns the whole array
// and lets the terminal's own scrollback own the history.
//
// Agent prose renders as markdown (pre-wrapped ANSI from markdown.ts) including
// in-flight streaming, which parses safely because CommonMark runs an unclosed
// code fence to end-of-input and unclosed inline markers stay literal until
// their closer streams in. User text stays raw.

import chalk from "chalk"
import type { LivePart, Message, Receipt, RosterItem, ToolActivity } from "@pipeline-moe/client-core"
import { renderMarkdownLines, renderStreamingMarkdownLines } from "./markdown"
import { groupActivity, groupLine, windowActivity, type ActivityGroup } from "./activity"
import { toSegments, windowSequence, type DisplaySegment } from "./parts"
import { fmtDuration, headerRule, receiptLines } from "./transcript-format"

export type Line = { text: string; color?: string; bold?: boolean; dim?: boolean; cursor?: boolean }

/** Reasoning is the agent talking to itself, and it must not read like the
 *  reply. `dimColor` alone was not enough once the two sat adjacent in one
 *  chronological flow (dax, 2026-07-25: "un peu messy") — the last line of a
 *  thought and the first line of the answer were the same white. An explicit
 *  gray plus a gutter separates them by colour AND by shape. */
const THOUGHT = { color: "gray" } as const

/** The gutter is two columns, the same width as the indent it replaces, so a
 *  thought occupies exactly the rows it did before. Blank lines inside a
 *  thought keep the bar, so the band stays continuous through a paragraph
 *  break instead of looking like the thought ended. */
const THOUGHT_GUTTER = "│ "

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

export interface TranscriptInput {
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
}

export interface TranscriptOptions {
  /** ⌃T. Thoughts are shown in full by default: the interleaved layout is what
   *  changed the balance — a thought is no longer one wall glued to the top of
   *  a turn, it is the sentence that explains the tool call under it, and
   *  collapsed it explains nothing (dax, 2026-07-26). */
  showThoughts: boolean
  /** ⌃O. Expand every folded tool call / hidden segment. */
  showTools: boolean
}

export interface TranscriptFlatten {
  lines: Line[]
  /** Whether anything on screen can actually be folded — a client only
   *  advertises ⌃T when there is a thought to fold. Computed here because this
   *  is the only place that walks every turn. */
  hasThoughts: boolean
}

/** Flatten a room into display lines. Pure: same inputs, same output, no
 *  terminal, no framework — which is what makes it unit-testable and lets the
 *  bench hand the identical array to both renderers. */
export function transcriptLines(
  s: TranscriptInput,
  width: number,
  opts: TranscriptOptions = { showThoughts: true, showTools: false },
): TranscriptFlatten {
  const { showThoughts, showTools } = opts
  const lines: Line[] = []
  let hasThoughts = false

  const byId = new Map(s.roster.map((r) => [r.id, r]))
  const colorOf = (author: string): string =>
    author === "user" ? "white" : author === "shell" ? "yellow" : byId.get(author)?.color ?? "magenta"
  const nameOf = (author: string, fallback: string): string =>
    author === "user" ? "You" : byId.get(author)?.name ?? fallback
  const iconOf = (author: string): string | undefined =>
    author === "user" || author === "shell" ? undefined : byId.get(author)?.icon

  const pushThoughtLine = (text: string): void => {
    lines.push({ text: THOUGHT_GUTTER + text, ...THOUGHT })
  }

  /** The head of a thought block, and it must NOT depend on whether the thought
   *  is still streaming.
   *
   *  It used to read "💭 thinking…" live and "💭 thought" once the reasoning
   *  stopped being the in-flight segment. That word swap happens at the TOP of
   *  a turn's block, with the whole body appended below it — so on any turn
   *  taller than the viewport it rewrote a line that had already scrolled away,
   *  and pi-tui answers that by clearing the terminal's scrollback. Measured
   *  2026-07-26: 6 full redraws on a 16-row screen, 1 on a 40-row one.
   *
   *  The liveness signal moved to where it costs nothing: the streaming cursor
   *  now sits on the LAST line of a live block, which is the line your eye is on
   *  anyway and is always inside the viewport. */
  const THOUGHT_HEAD = "💭 thought"

  // The web UI's collapsible 💭 block, shown in full by default; ⌃T collapses
  // every thought to one line, for when a reasoning trace dwarfs the reply. The
  // key is advertised once in the chrome, which is always on screen and costs
  // no row — repeating it on each of a turn's four thought headers would be
  // four times the chrome for the same one fact.
  const pushThought = (reasoning: string, live: boolean): void => {
    hasThoughts = true
    const wrapped = wrap(reasoning.trim(), Math.max(10, width - 2))
    if (showThoughts) {
      lines.push({ text: THOUGHT_HEAD, ...THOUGHT })
      for (const l of wrapped) pushThoughtLine(l)
    } else if (live) {
      // Collapsed AND live: the tail of the thought, so you can watch it move.
      // This head still differs from the finalized one below — accepted,
      // because collapsing is what makes a turn SHORT, and the rewrite only
      // costs anything when a single turn is taller than the viewport.
      lines.push({ text: THOUGHT_HEAD, ...THOUGHT })
      for (const l of wrapped.slice(-2)) pushThoughtLine(l)
    } else {
      lines.push({ text: `${THOUGHT_HEAD} (${wrapped.length} line${wrapped.length === 1 ? "" : "s"})`, ...THOUGHT })
    }
  }

  // ── Tool call activity ───────────────────────────────────────────────

  const pushActivity = (activity: ToolActivity[], live: boolean): void => {
    if (activity.length === 0) return
    const hasRunning = live && activity.some((a) => a.status === "running")
    const errors = activity.filter((a) => a.status === "error").length
    const count = `🔧 ${activity.length} tool ${activity.length === 1 ? "call" : "calls"}`
    const errSuffix = errors ? ` · ${errors} ✗` : ""
    const runSuffix = hasRunning ? " · running…" : ""
    const argWidth = Math.max(10, width - 32) // leave room for icon + name + badge
    const pushGroup = (g: ActivityGroup): void => {
      const l = groupLine(g, argWidth)
      lines.push({ text: l.text, color: l.color === "green" ? undefined : l.color })
    }
    if (showTools) {
      // Fully expanded (⌃O): one line per call, no aggregation.
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
  const pushReasoningSegment = (content: string, live: boolean): void => {
    hasThoughts = true
    const wrapped = wrap(content, Math.max(10, width - 2))
    if (showThoughts) {
      lines.push({ text: THOUGHT_HEAD, ...THOUGHT })
      for (const l of wrapped) pushThoughtLine(l)
    } else if (live) {
      // The tail of a thought in flight, so you can watch it move.
      lines.push({ text: THOUGHT_HEAD, ...THOUGHT })
      for (const l of wrapped.slice(-2)) pushThoughtLine(l)
    } else {
      lines.push({ text: `💭 ${wrapped.length} line${wrapped.length === 1 ? "" : "s"}`, ...THOUGHT })
    }
  }

  const pushSegment = (seg: DisplaySegment, live: boolean, argWidth: number): void => {
    if (seg.kind === "tools") {
      const l = groupLine(seg.group, argWidth)
      lines.push({ text: l.text, color: l.color === "green" ? undefined : l.color })
    } else if (seg.kind === "reasoning") {
      pushReasoningSegment(seg.content, live)
    } else {
      const rendered = live
        ? renderStreamingMarkdownLines(seg.content, width) ?? wrap(seg.content, width)
        : renderMarkdownLines(seg.content, width) ?? wrap(seg.content, width)
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
    const draw = (seg: DisplaySegment): void => pushSegment(seg, live && seg === inFlight, argWidth)
    // ⌃O expands the sequence, the same key that expands a tool block — both
    // are "show me everything that got folded away".
    if (showTools) {
      for (const seg of segments) draw(seg)
      return true
    }
    const { head, pinnedErrors, hidden, tail } = windowSequence(segments)
    for (const seg of head) draw(seg)
    for (const seg of pinnedErrors) draw(seg)
    if (hidden > 0) lines.push({ text: `  ⋯ ${hidden} segment${hidden === 1 ? "" : "s"} hidden · ctrl+o`, dim: true })
    for (const seg of tail) draw(seg)
    return true
  }

  for (const m of s.messages) {
    // Full-width rule in the author's color — the TUI counterpart of the
    // WebUI's per-reply card border; replaces the bare name line (no extra row).
    //
    // NO duration here, deliberately. It used to read "── 🔨 Builder · 12s ──",
    // which meant the live block and the finalized message disagreed on their
    // very FIRST line, and a turn taller than the viewport therefore rewrote a
    // line that had scrolled away — clearing the terminal scrollback the whole
    // architecture exists to preserve. The duration is a RESULT, so it now
    // closes the block instead of opening it (see durationLine below), where
    // the bottom of a block is always on screen and a rewrite is free.
    lines.push({
      text: headerRule(nameOf(m.author, m.authorName), iconOf(m.author), width),
      bold: true,
      color: colorOf(m.author),
    })
    // Chronological when the entry carries it; grouped otherwise.
    const interleaved = m.parts?.length ? pushSequence(m.parts, m.activity, false) : false
    if (!interleaved) {
      if (m.reasoning) pushThought(m.reasoning, false)
      if (m.activity?.length) pushActivity(m.activity, false)
    }
    if (m.images?.length) {
      lines.push({ text: `📎 ${m.images.length} image${m.images.length === 1 ? "" : "s"}`, dim: true })
    }
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
    } else if (!proseDrawn && !m.question) {
      lines.push({ text: "(no response)", dim: true })
    }
    // ask_user callout — the WebUI shows this as a 🤚 banner under the bubble;
    // the TUI only surfaced the question in the status bar, so it vanished from
    // the story once answered. Options render dim so the scrollback shows what
    // was offered.
    if (m.question) {
      for (const l of wrap(`🤚 ${m.question}`, width)) lines.push({ text: l, color: "magenta" })
      for (const [i, o] of (m.questionOptions ?? []).entries()) {
        for (const l of wrap(`   ${i + 1} ${o}`, width)) lines.push({ text: l, dim: true })
      }
    }
    // Routing decision footer — a tool-only handoff is invisible in the reply
    // text, and the next agent otherwise appears to take over at random
    // (observed live: tester silently handed to scribe twice, 2026-07-10).
    if (m.handoffTo) lines.push({ text: `↪ handoff → @${m.handoffTo}`, dim: true })
    if (s.receipts[m.index]) for (const l of receiptLines(s.receipts[m.index])) lines.push(l)
    // The turn's closing line. Right-aligned and dim so it reads as a receipt
    // and not as content — and placed last on purpose: this is the one line of
    // a turn that appears only at finalization, so it must sit where a rewrite
    // is guaranteed to be inside the viewport.
    if (m.durationMs != null) {
      const d = fmtDuration(m.durationMs)
      lines.push({ text: " ".repeat(Math.max(0, width - d.length)) + d, dim: true })
    }
    lines.push({ text: "" })
  }

  // Live blocks: an agent can be reasoning before its first text token, so walk
  // the union of both buffers.
  const liveIds = [
    ...new Set([...Object.keys(s.streaming), ...Object.keys(s.liveReasoning), ...Object.keys(s.liveActivity)]),
  ]
  for (const id of liveIds) {
    const text = s.streaming[id] ?? ""
    const reasoning = s.liveReasoning[id] ?? ""
    const acts = s.liveActivity[id] ?? []
    const parts = s.liveParts?.[id]
    if (!text && !reasoning && acts.length === 0) continue
    // Byte-identical to the rule the finalized message will render — same
    // width, no duration, no cursor. That identity is the whole point: when the
    // turn lands, this line must not change, because by then it may be far
    // above the viewport.
    const blockHead = lines.length
    lines.push({ text: headerRule(nameOf(id, id), iconOf(id), width), bold: true, color: colorOf(id) })
    // The live sequence is the SAME sequence the entry will carry — the server
    // stamped the boundaries, so the turn does not visibly re-order when the
    // message lands (verified live, 2026-07-25: 9 segments assembled from the
    // stream, 9 persisted, identical).
    if (!(parts?.length && pushSequence(parts, acts, true))) {
      // Live = the agent is thinking RIGHT NOW (last delta was reasoning) — not
      // "no text yet": a second burst after text/tools re-opens "thinking…"
      // instead of silently growing the collapsed thought block.
      if (reasoning) pushThought(reasoning, s.reasoningActive[id] ?? !text)
      if (acts.length) pushActivity(acts, true)
      if (text) {
        for (const l of renderStreamingMarkdownLines(text, width) ?? wrap(text, width)) lines.push({ text: l })
      }
    }
    // The streaming cursor rides the LAST line of the block, not the header.
    // It moves down as the turn grows, so the only lines it ever dirties are
    // the last two — always on screen, never in the scrollback. Guarded to the
    // body: a cursor parked on the header would have to be removed once the
    // first body line arrived, which is the rewrite we just eliminated.
    const last = lines.length - 1
    if (last > blockHead) lines[last] = { ...lines[last]!, cursor: true }
    lines.push({ text: "" })
  }

  return { lines, hasThoughts }
}

/** Apply a Line's styling as ANSI. Ink reads the same fields as JSX props
 *  (`bold` / `color` / `dimColor`) and needs none of this; pi-tui diffs plain
 *  strings, so the escape codes have to be baked in. */
export function paint(l: Line): string {
  let out = l.text
  if (!out) return ""
  if (l.color) {
    out = l.color.startsWith("#")
      ? chalk.hex(l.color)(out)
      : (chalk as never as Record<string, (s: string) => string>)[l.color]?.(out) ?? out
  }
  if (l.bold) out = chalk.bold(out)
  if (l.dim) out = chalk.dim(out)
  return out
}
