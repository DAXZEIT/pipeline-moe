// Transcript → display lines, with NO rendering framework attached.
//
// This is the body of `Transcript.tsx` with React removed: the same helpers
// (markdown.ts, activity.ts, parts.ts, transcript-format.ts), the same windowing
// decisions, the same THOUGHT gutter — but it returns ANSI strings instead of
// <Text> elements. That is the whole hypothesis of this prototype: our
// transcript is ALREADY a `render(width): string[]`, and Ink was only ever
// painting the result.
//
// Deliberately a copy, not an extraction: the production Transcript stays
// untouched while the prototype is priced. If pi-tui wins, this file becomes
// the extraction and Transcript.tsx shrinks to a call site.

import chalk from "chalk"
import type { LivePart, Message, Receipt, RosterItem, ToolActivity } from "@pipeline-moe/client-core"
import { renderMarkdownLines, renderStreamingMarkdownLines } from "../src/markdown"
import { groupActivity, groupLine, windowActivity, type ActivityGroup } from "../src/activity"
import { toSegments, windowSequence, type DisplaySegment } from "../src/parts"
import { fmtDuration, headerRule, receiptLines } from "../src/transcript-format"

export type Line = { text: string; color?: string; bold?: boolean; dim?: boolean }

const THOUGHT = { color: "gray" } as const
const THOUGHT_GUTTER = "│ "

/** Same wrap as Transcript.tsx — hard newlines preserved, over-long words split. */
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
  liveParts?: Record<string, LivePart[]>
  reasoningActive: Record<string, boolean>
  receipts: Record<number, Receipt>
}

export interface TranscriptOptions {
  showThoughts: boolean
  showTools: boolean
}

/** Flatten a room into display lines. Pure: same inputs, same output, no
 *  terminal, no framework — which is what makes it benchmarkable against both
 *  renderers with the identical line array. */
export function transcriptLines(
  s: TranscriptInput,
  width: number,
  opts: TranscriptOptions = { showThoughts: true, showTools: false },
): Line[] {
  const { showThoughts, showTools } = opts
  const lines: Line[] = []

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

  const pushThought = (reasoning: string, live: boolean): void => {
    const wrapped = wrap(reasoning.trim(), Math.max(10, width - 2))
    if (showThoughts) {
      lines.push({ text: live ? "💭 thinking…" : "💭 thought", ...THOUGHT })
      for (const l of wrapped) pushThoughtLine(l)
    } else if (live) {
      lines.push({ text: "💭 thinking…", ...THOUGHT })
      for (const l of wrapped.slice(-2)) pushThoughtLine(l)
    } else {
      lines.push({ text: `💭 thought (${wrapped.length} line${wrapped.length === 1 ? "" : "s"})`, ...THOUGHT })
    }
  }

  const pushActivity = (activity: ToolActivity[], live: boolean): void => {
    if (activity.length === 0) return
    const hasRunning = live && activity.some((a) => a.status === "running")
    const errors = activity.filter((a) => a.status === "error").length
    const count = `🔧 ${activity.length} tool ${activity.length === 1 ? "call" : "calls"}`
    const errSuffix = errors ? ` · ${errors} ✗` : ""
    const runSuffix = hasRunning ? " · running…" : ""
    const argWidth = Math.max(10, width - 32)
    const pushGroup = (g: ActivityGroup): void => {
      const l = groupLine(g, argWidth)
      lines.push({ text: l.text, color: l.color === "green" ? undefined : l.color })
    }
    if (showTools) {
      lines.push({ text: `${count}${errSuffix}${runSuffix}`, dim: true })
      for (const a of activity) pushGroup({ toolName: a.toolName, items: [a], status: a.status })
    } else if (live) {
      const { pinnedErrors, visible, hiddenCalls } = windowActivity(groupActivity(activity))
      const hidden = hiddenCalls ? ` · ${hiddenCalls} earlier · ctrl+o` : ""
      lines.push({ text: `${count}${errSuffix}${hidden}${runSuffix}`, dim: true })
      for (const g of pinnedErrors) pushGroup(g)
      if (hiddenCalls) lines.push({ text: "  ⋯", dim: true })
      for (const g of visible) pushGroup(g)
    } else {
      lines.push({ text: `${count}${errSuffix} · ctrl+o`, dim: true })
    }
  }

  const pushReasoningSegment = (content: string, live: boolean): void => {
    const wrapped = wrap(content, Math.max(10, width - 2))
    if (showThoughts) {
      lines.push({ text: live ? "💭 thinking…" : "💭 thought", ...THOUGHT })
      for (const l of wrapped) pushThoughtLine(l)
    } else if (live) {
      lines.push({ text: "💭 thinking…", ...THOUGHT })
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

  const pushSequence = (
    parts: readonly { type: "reasoning" | "text" | "tool"; content?: string; toolCallId?: string }[],
    activity: ToolActivity[] | undefined,
    live: boolean,
  ): boolean => {
    const segments = toSegments(parts as never, activity)
    if (segments.length === 0) return false
    const argWidth = Math.max(10, width - 32)
    const inFlight = segments[segments.length - 1]
    const draw = (seg: DisplaySegment): void => pushSegment(seg, live && seg === inFlight, argWidth)
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
    lines.push({
      text: headerRule(
        nameOf(m.author, m.authorName),
        iconOf(m.author),
        width,
        m.durationMs != null ? fmtDuration(m.durationMs) : undefined,
      ),
      bold: true,
      color: colorOf(m.author),
    })
    const interleaved = m.parts?.length ? pushSequence(m.parts, m.activity, false) : false
    if (!interleaved) {
      if (m.reasoning) pushThought(m.reasoning, false)
      if (m.activity?.length) pushActivity(m.activity, false)
    }
    if (m.images?.length) {
      lines.push({ text: `📎 ${m.images.length} image${m.images.length === 1 ? "" : "s"}`, dim: true })
    }
    const proseDrawn = interleaved && m.parts!.some((p) => p.type === "text")
    if (m.text && !proseDrawn) {
      const rendered =
        m.author === "user" || m.author === "shell"
          ? wrap(m.text, width)
          : renderMarkdownLines(m.text, width) ?? wrap(m.text, width)
      for (const l of rendered) lines.push({ text: l })
    } else if (!proseDrawn && !m.question) {
      lines.push({ text: "(no response)", dim: true })
    }
    if (m.question) {
      for (const l of wrap(`🤚 ${m.question}`, width)) lines.push({ text: l, color: "magenta" })
      for (const [i, o] of (m.questionOptions ?? []).entries()) {
        for (const l of wrap(`   ${i + 1} ${o}`, width)) lines.push({ text: l, dim: true })
      }
    }
    if (m.handoffTo) lines.push({ text: `↪ handoff → @${m.handoffTo}`, dim: true })
    if (s.receipts[m.index]) for (const l of receiptLines(s.receipts[m.index])) lines.push(l)
    lines.push({ text: "" })
  }

  const liveIds = [
    ...new Set([...Object.keys(s.streaming), ...Object.keys(s.liveReasoning), ...Object.keys(s.liveActivity)]),
  ]
  for (const id of liveIds) {
    const text = s.streaming[id] ?? ""
    const reasoning = s.liveReasoning[id] ?? ""
    const acts = s.liveActivity[id] ?? []
    const parts = s.liveParts?.[id]
    if (!text && !reasoning && acts.length === 0) continue
    lines.push({ text: headerRule(nameOf(id, id), iconOf(id), width - 2), bold: true, color: colorOf(id) })
    if (!(parts?.length && pushSequence(parts, acts, true))) {
      if (reasoning) pushThought(reasoning, s.reasoningActive[id] ?? !text)
      if (acts.length) pushActivity(acts, true)
      if (text) {
        for (const l of renderStreamingMarkdownLines(text, width) ?? wrap(text, width)) lines.push({ text: l })
      }
    }
    lines.push({ text: "" })
  }

  return lines
}

/** Apply a Line's styling as ANSI. Ink did this from JSX props; pi-tui wants
 *  the escape codes baked into the string it diffs. */
export function paint(l: Line): string {
  let out = l.text
  if (!out) return ""
  if (l.color) {
    out = l.color.startsWith("#") ? chalk.hex(l.color)(out) : (chalk as never as Record<string, (s: string) => string>)[l.color]?.(out) ?? out
  }
  if (l.bold) out = chalk.bold(out)
  if (l.dim) out = chalk.dim(out)
  return out
}
