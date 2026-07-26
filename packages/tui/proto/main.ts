#!/usr/bin/env -S npx tsx
// pmoe-proto — the pipeline-moe terminal client rendered on @earendil-works/pi-tui
// instead of Ink, to price the migration honestly (docs/tui-lessons-from-pi.md,
// backlog #1). THROWAWAY. Nothing in src/ imports it.
//
//   npx tsx packages/tui/proto/main.ts [--server http://localhost:5300] [--room default]
//
// What it is testing, in order of what it would cost to be wrong about:
//
//  1. Does @pipeline-moe/client-core survive untouched? (the strategic asset)
//  2. Is our transcript already a `render(width): string[]`? (proto/lines.ts)
//  3. Does the conversation land in NATIVE SCROLLBACK — real wheel, real
//     selection, terminal search — with no scroll state of our own?
//  4. What does a streaming frame actually cost, versus Ink? (--stats, and
//     proto/bench.ts for the hard number)
//
// What it deliberately does NOT port: overlays, room tabs, the roster strip's
// gauges, slash commands, images. Those are the migration's real bulk and the
// prototype exists to price them, not to pre-pay them.

import { TUI, ProcessTerminal, Editor, Text, truncateToWidth, matchesKey, type Component } from "@earendil-works/pi-tui"
import chalk from "chalk"
import { createRoomStore, preloadRoomState } from "@pipeline-moe/client-core"
import type { RoomState } from "@pipeline-moe/client-core"
import { nodeEventSourceFactory } from "../src/nodeEventSource"
import { transcriptLines, paint } from "./lines"

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const apiBase = arg("--server", process.env.PMOE_SERVER ?? "http://localhost:5300")
const roomId = arg("--room", "default")
const showStats = process.argv.includes("--stats")

/* ── The transcript, as a pi-tui component ──────────────────────────────────
 *
 * Note what is NOT here: no offset, no maxOffset, no PgUp/PgDn, no reservedRows,
 * no bodyHeight arithmetic, no windowing. It returns the WHOLE conversation
 * every frame and lets the terminal own the scrollback. The TUI diffs the array
 * and rewrites only the lines that changed — everything above the viewport is
 * inert by construction (tui.ts: `firstChanged < prevViewportTop` is the only
 * path that would touch it, and finalized lines never change).
 */
class TranscriptComponent implements Component {
  // The collapsed tool line prints "· ctrl+o" and the fold hint prints "⌃T" —
  // promises the transcript makes on screen, so the prototype has to keep them
  // or it is measuring a different UI than the one we ship.
  showThoughts = true
  showTools = false

  constructor(private getState: () => RoomState) {}

  invalidate(): void {}

  render(width: number): string[] {
    const state = this.getState()
    const w = Math.max(20, width - 2)
    const lines = transcriptLines(
      {
        messages: state.messages,
        roster: state.roster,
        streaming: state.streaming,
        liveReasoning: state.liveReasoning,
        liveActivity: state.liveActivity,
        liveParts: state.liveParts,
        reasoningActive: state.reasoningActive,
        receipts: state.receipts,
      },
      w,
      { showThoughts: this.showThoughts, showTools: this.showTools },
    )
    // pi-tui THROWS if a rendered line exceeds the width — the invariant our
    // Ink layer enforces silently with wrap="truncate-end". Same rule, but it
    // is now a hard error instead of a cropped table nobody notices.
    return lines.map((l) => " " + truncateToWidth(paint(l), w))
  }
}

/** One-line header: room, roster, who is running. The Ink RosterStrip's job,
 *  minus the gauges — enough to prove chrome coexists with an append-only
 *  transcript, which is the layout question worth answering. */
class HeaderComponent implements Component {
  constructor(private getState: () => RoomState) {}

  invalidate(): void {}

  render(width: number): string[] {
    const s = this.getState()
    const names = s.roster
      .filter((r) => r.active)
      .map((r) => (r.id === s.runningAgentId ? chalk.bold.green(`▶ ${r.name}`) : chalk.hex(r.color)(r.name)))
      .join(chalk.dim(" · "))
    const head = `${chalk.bold(roomId)} ${chalk.dim("│")} ${names}`
    return [truncateToWidth(head, width), chalk.dim("─".repeat(Math.max(0, width)))]
  }
}

/** Stats line — the point of the prototype made visible while you use it.
 *  `fullRedraws` is pi-tui's own counter: every increment is a frame that had
 *  to clear the screen AND the scrollback. It should stay at 1 (first render)
 *  through an entire streaming turn, and only move when you resize. */
class StatsComponent implements Component {
  constructor(
    private tui: TUI,
    private bytes: () => number,
    private frames: () => number,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (!showStats) return []
    const kb = (this.bytes() / 1024).toFixed(1)
    const f = this.frames()
    const perFrame = f > 0 ? Math.round(this.bytes() / f) : 0
    return [
      truncateToWidth(
        chalk.dim(`⟨ frames ${f} · ${kb} KiB written · ${perFrame} B/frame · full redraws ${this.tui.fullRedraws} ⟩`),
        width,
      ),
    ]
  }
}

async function main(): Promise<void> {
  const initialState = await preloadRoomState(apiBase, roomId).catch(() => undefined)
  const store = createRoomStore({
    apiBase,
    roomId,
    eventSourceFactory: nodeEventSourceFactory,
    ...(initialState ? { initialState } : {}),
  })

  const terminal = new ProcessTerminal()
  // Count what actually reaches the terminal. This is the number Ink cannot
  // win: it erases and rewrites the whole frame on every token (log-update.js:
  // `eraseLines(previousLineCount) + output`).
  let bytes = 0
  let frames = 0
  const rawWrite = terminal.write.bind(terminal)
  terminal.write = (data: string): void => {
    bytes += Buffer.byteLength(data)
    frames += 1
    rawWrite(data)
  }

  const tui = new TUI(terminal, true)
  const getState = (): RoomState => store.getSnapshot()

  // Layout order is load-bearing, and this is the prototype's sharpest finding.
  // Mutating chrome ABOVE the transcript sits at a line index that never grows,
  // so every roster change rewrites a line that has long since scrolled above
  // the viewport — and pi-tui answers that with a full redraw that clears the
  // scrollback (`firstChanged < prevViewportTop`, tui.ts:1459). Measured: header
  // on top → a full redraw per turn; header below → one, ever.
  //
  // Our Ink layout puts RoomTabs + RosterStrip + TaskSummary + divider on top.
  // All of it has to move below the conversation to migrate. pi does exactly
  // that, and now the reason is obvious rather than aesthetic.
  const transcript = new TranscriptComponent(getState)
  tui.addChild(transcript)
  tui.addChild(new HeaderComponent(getState))
  tui.addChild(new StatsComponent(tui, () => bytes, () => frames))

  const editor = new Editor(tui, {
    borderColor: (s: string) => chalk.dim(s),
    selectList: {
      selectedPrefix: (s: string) => chalk.cyan(s),
      selectedText: (s: string) => chalk.cyan(s),
      description: (s: string) => chalk.dim(s),
      scrollInfo: (s: string) => chalk.dim(s),
      noMatch: (s: string) => chalk.dim(s),
    },
  })
  editor.onSubmit = (text: string): void => {
    const t = text.trim()
    if (!t) return
    if (t === "/quit" || t === "/exit") {
      tui.stop()
      store.stop()
      process.exit(0)
    }
    store.actions.send(t)
    editor.setText("")
  }
  tui.addChild(editor)
  tui.addChild(new Text(chalk.dim("  /quit to exit · ⌃O tools · ⌃T thoughts · scroll with your terminal, not with this app")))
  tui.setFocus(editor)

  // Ctrl+O / Ctrl+T. An input listener runs BEFORE the focused component, so
  // the Editor never sees these — the same arbitration Ink gave us for free by
  // having CommandLine ignore ctrl-chords.
  tui.addInputListener((data: string) => {
    if (matchesKey(data, "ctrl+o")) {
      transcript.showTools = !transcript.showTools
      tui.requestRender()
      return { consume: true }
    }
    if (matchesKey(data, "ctrl+t")) {
      transcript.showThoughts = !transcript.showThoughts
      tui.requestRender()
      return { consume: true }
    }
    return undefined
  })

  store.subscribe(() => tui.requestRender())
  store.start()

  tui.start()
  // The store drives renders; nothing polls.
  await new Promise(() => {})
}

void main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
