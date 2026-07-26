// The chrome — room tabs, roster strip, task summary, notices, status bar —
// flattened to painted ANSI lines, with no rendering framework attached.
//
// WHY IT IS ALL ONE MODULE, AND WHY IT RENDERS BELOW THE CONVERSATION
//
// Chrome placed ABOVE an append-only transcript sits at a line index that never
// grows. Every roster change then rewrites a line that scrolled above the
// viewport long ago, and pi-tui answers that with a full redraw which clears the
// screen AND the terminal's scrollback. Measured on a live room, same turns:
// header above → one full redraw per turn; header below → one, ever.
//
// So position is not taste here, it is the load-bearing constraint. Below the
// transcript, a chrome line's index is always near the end of the buffer, and a
// mutating status bar — even one that ticks every second — costs a single line's
// worth of writes and never touches history. That is also why every one of these
// may freely change HEIGHT (notices appearing, the task board filling): shifting
// lines that are all below the fold is free.
//
// The Ink client keeps its own JSX versions of these six components, frozen,
// until Phase 6 deletes them. That duplication is deliberate and time-boxed:
// rewriting a working client's chrome to consume line arrays would be churn on
// code scheduled for deletion, and no feature work happens during the migration
// (docs/tui-pitui-migration-plan.md). It is the opposite call from the
// transcript, which was extracted precisely because it must survive.
//
// Unlike transcript-lines.ts this module is NOT framework-agnostic — it uses
// pi-tui's ANSI-aware `truncateToWidth`, because it exists to serve the pi-tui
// client and nothing else. What it keeps is the property that actually buys
// something: it is a pure function of state, so the whole chrome is testable
// with no terminal and no renderer.

import chalk from "chalk"
import stringWidth from "string-width"
import { truncateToWidth } from "@earendil-works/pi-tui"
import type { Notice, RoomSummary, RoomTask, RosterItem, RoutingMode } from "@pipeline-moe/client-core"
import { renderStrip, stripCells } from "./roster-strip"
import { ROUTING_COLOR } from "./input-mode"
import { fmt } from "./roster-stats"
import { fmtDuration } from "./transcript-format"

export interface ChromeInput {
  roomId: string
  rooms: RoomSummary[]
  /** The trailing "+ room" tab is selected — ⏎ opens the create-room form. */
  plusSelected: boolean
  conversationTitle?: string
  roster: RosterItem[]
  runningAgentId: string | null
  defaultModel: string | null
  tasks: RoomTask[]
  notices: Notice[]
  connection: "connecting" | "connected" | "reconnecting"
  turnActive: boolean
  /** Epoch ms the running agent started — drives the elapsed counter. */
  runningSince: number | null
  paused: boolean
  pausedAskerId: string | null
  routingMode: RoutingMode
  messageCount: number
  /** Preset provenance + drift; null when the room is not from a preset. */
  drift?: { preset: string; deviates: boolean } | null
  /** Room-level context load; null before the first turn reports usage. */
  roomUsage?: { tokens: number; hotPercent: number | null } | null
  /** Explicit routing of the CURRENT draft. Null when it routes by default, so
   *  the common case stays quiet. */
  draftTargets?: { t: string[]; d: string[] } | null
  /** Injected rather than read from the clock, so the elapsed counter is
   *  testable and the module stays pure. */
  now?: number
}

const MAX_TITLE = 28

/** Fit a painted line to `width`, satisfying BOTH width measures.
 *
 *  They disagree, and the disagreement is not academic: `▶` (U+25B6) is East
 *  Asian Ambiguous, and `string-width` calls it 2 columns while pi-tui's
 *  measure calls it 1. Our status bar and task line both use it, so a line
 *  pi-tui believed fitted came out one column too wide by the other measure —
 *  and if the TERMINAL sides with string-width, that line soft-wraps, every
 *  chrome row below it shifts by one, and pi-tui's line accounting is silently
 *  off for the rest of the session.
 *
 *  Nobody here can be sure which measure a given terminal follows, so satisfy
 *  the stricter one. The loop converges in one or two steps (the disagreement is
 *  a column or two, never more) and runs on ~7 lines per frame. */
function fit(line: string, width: number): string {
  const visible = (s: string): number => stringWidth(s.replace(/\x1b\[[0-9;]*m/g, ""))
  let target = width
  let out = truncateToWidth(line, target)
  while (target > 0 && visible(out) > width) {
    target -= 1
    out = truncateToWidth(line, target)
  }
  return out
}

/** Browser-style room tabs plus the trailing "+ room", and the current
 *  discussion's title. A room whose goal is still running gets a dot, so
 *  background sub-rooms are visible at a glance.
 *
 *  One line, always. The Ink version could flex-wrap to two rows; here a line
 *  must fit the width or pi-tui throws, so many rooms truncate rather than
 *  wrap. Truncating the tab list is the right loss: the CURRENT room is
 *  rendered first among equals and ←→ still reaches the rest. */
function tabsLine(s: ChromeInput): string {
  const tabs = s.rooms.map((r) => {
    const active = !s.plusSelected && r.roomId === s.roomId
    const label = ` ${r.goalStatus === "running" ? "● " : ""}${r.name} `
    return active ? chalk.inverse.cyan(label) : chalk.dim(label)
  })
  const plus = s.plusSelected ? chalk.inverse.green(" + room ") : chalk.dim(" + room ")
  const hint = chalk.dim(s.plusSelected ? "  ⏎ create / resume" : "  ←→ switch")
  const title =
    s.conversationTitle && s.conversationTitle.length > MAX_TITLE
      ? s.conversationTitle.slice(0, MAX_TITLE - 1) + "…"
      : s.conversationTitle || "—"
  return ` ${tabs.join(" ")} ${plus}${hint}${chalk.dim("  · 💬 ")}${chalk.cyan(title)}`
}

/** One-line task-board summary: progress count + what is in flight. Renders
 *  nothing while the board is empty, which is most rooms most of the time. */
function taskLines(tasks: RoomTask[]): string[] {
  if (tasks.length === 0) return []
  const done = tasks.filter((t) => t.status === "completed").length
  const inProgress = tasks.filter((t) => t.status === "in_progress")
  // Show what is active; if nothing is claimed yet, show the next pending task.
  const shown = inProgress.length > 0 ? inProgress.slice(0, 2) : tasks.filter((t) => t.status === "pending").slice(0, 1)
  const parts = shown.map((t) => {
    const label = `  ${t.status === "in_progress" ? "▶" : "☐"} ${t.subject}`
    return t.status === "in_progress" ? chalk.yellow(label) : chalk.dim(label)
  })
  return [` ${chalk.bold.cyan(`TASKS ${done}/${tasks.length}`)}${parts.join("")}${chalk.dim("  ⌃P")}`]
}

/** Transient notices — command confirmations, errors, async results. The store
 *  TTL-expires them; only the most recent few are shown so a burst never pushes
 *  the editor off-screen. */
function noticeLines(notices: Notice[]): string[] {
  return notices.slice(-3).map((n) => {
    const line = `${n.level === "error" ? "✗ " : "› "}${n.msg}`
    return " " + (n.level === "error" ? chalk.red(line) : chalk.gray(line))
  })
}

/** One-line room status. `connection` distinguishes an EventSource retrying
 *  after a drop from the initial connect, since the store only exposes a
 *  boolean and the stream auto-retries until stopped. */
function statusLine(s: ChromeInput): string {
  const conn =
    s.connection === "connected"
      ? chalk.green("● connected")
      : s.connection === "reconnecting"
        ? chalk.yellow("◌ reconnecting…")
        : chalk.gray("○ connecting…")

  let activity: string
  if (s.paused) {
    // An ask_user pause is NOT idle — the room holds a frozen queue and waits
    // on the user. Saying "idle" made a legitimate 409 on another action read
    // as a corrupted state.
    activity = chalk.magenta(`⏸ paused — waiting for your answer${s.pausedAskerId ? ` to @${s.pausedAskerId}` : ""}`)
  } else if (s.turnActive) {
    const agent = s.roster.find((r) => r.id === s.runningAgentId)
    const who = agent ? chalk.hex(agent.color)(` ${agent.icon} ${agent.name}`) : ""
    const elapsed =
      s.runningSince != null ? chalk.reset(` · ${fmtDuration(Math.max(0, (s.now ?? Date.now()) - s.runningSince))}`) : ""
    activity = chalk.yellow("▶ running") + who + elapsed + chalk.dim(" — Esc to stop")
  } else {
    activity = chalk.gray("idle")
  }

  // Routing wears the same color the input border wears in plain-text mode —
  // one color per meaning across the whole chrome.
  const routing = chalk.dim("   routing:") + (chalk as never as Record<string, (v: string) => string>)[
    ROUTING_COLOR[s.routingMode]
  ]!(s.routingMode)
  const counts = chalk.dim(`  room:${s.roomId}  msgs:${s.messageCount}`)
  const drift = s.drift ? chalk.dim(`  preset:${s.drift.preset}`) + (s.drift.deviates ? chalk.yellow("*") : "") : ""
  // Tokens of the SHARED transcript (the GROUP context), counted once — NOT a
  // sum of per-seat personal contexts. hotPercent is null until room compaction
  // defines a threshold, so the color stays neutral and no `·%` is appended.
  const usage = s.roomUsage
    ? chalk.dim("  ctx:") +
      (s.roomUsage.hotPercent != null && s.roomUsage.hotPercent >= 80 ? chalk.yellow : chalk.gray)(
        fmt(s.roomUsage.tokens) + (s.roomUsage.hotPercent != null ? `·${Math.round(s.roomUsage.hotPercent)}%` : ""),
      )
    : ""
  const targets = s.draftTargets
    ? chalk.dim("   ⏎⇒ ") +
      chalk.cyan(s.draftTargets.t.map((id) => `@${id}`).join(" ") || "nobody") +
      (s.draftTargets.d.length > 0
        ? chalk.yellow(` (ignored: ${s.draftTargets.d.map((id) => `@${id}`).join(" ")})`)
        : "")
    : ""

  return ` ${conn}  ${activity}${routing}${counts}${drift}${usage}${targets}`
}

/** Every chrome line, in the order it is drawn BELOW the conversation, each
 *  already fitted to the width.
 *
 *  Fitting is done HERE and not left to the caller, unlike the transcript
 *  renderer. pi-tui throws on an over-wide line, and these lines are the ones
 *  most likely to be over-wide: a status bar with a preset, a context gauge and
 *  a routing preview measured 170 columns on a 120-column terminal in test.
 *  The invariant belongs next to the code that can violate it. */
export function chromeLines(s: ChromeInput, width: number): string[] {
  const w = Math.max(0, width)
  return [
    // The rule reads as the boundary between the story and the instruments.
    // Note it is also the most expensive chrome line to repaint: a full width of
    // box-drawing glyphs is 3 bytes each, and every chrome line is rewritten
    // whenever the transcript's line count shifts beneath it.
    chalk.dim("─".repeat(w)),
    tabsLine(s),
    // The strip builds itself to `w`, so the one-column indent has to come out
    // of its budget rather than be added on top of it.
    ...(s.roster.length > 0
      ? renderStrip(stripCells(s.roster, s.runningAgentId, Math.max(0, w - 1), s.defaultModel)).map((r) => " " + r)
      : []),
    ...taskLines(s.tasks),
    ...noticeLines(s.notices),
    statusLine(s),
  ].map((l) => fit(l, w))
}
