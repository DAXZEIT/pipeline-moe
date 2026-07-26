#!/usr/bin/env -S npx tsx
// pmoe-next — the pipeline-moe terminal client on @earendil-works/pi-tui.
//
//   pmoe-next [--server http://localhost:5300] [--room default] [--stats]
//
// This is the second client, growing beside the Ink one (`src/`) on the same
// @pipeline-moe/client-core. Both are shipped; `pmoe` stays the default until
// this one reaches parity. See docs/tui-pitui-migration-plan.md for the phase
// order and the five gates every phase must re-pass.
//
// Phase 0 status: transcript + a minimal chrome line + the Editor. Not yet
// ported: room tabs, the roster strip's gauges, overlays, slash commands,
// notices, images. Those are phases 1-5.
//
// The one thing this client does NOT have, by design: scroll state. No offset,
// no maxOffset, no PgUp/PgDn, no reservedRows arithmetic, no bodyHeight. The
// conversation grows into the terminal's OWN scrollback, so the wheel, text
// selection and terminal search are the terminal's — not a re-implementation.

import { TUI, ProcessTerminal, Editor, Text, truncateToWidth, matchesKey, type Component } from "@earendil-works/pi-tui"
import chalk from "chalk"
import { createRoomStore, preloadRoomState } from "@pipeline-moe/client-core"
import type { RoomState } from "@pipeline-moe/client-core"
import { nodeEventSourceFactory } from "../nodeEventSource"
import { transcriptLines, paint } from "../transcript-lines"

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const apiBase = arg("--server", process.env.PMOE_SERVER ?? "http://localhost:5300")
const roomId = arg("--room", "default")
const showStats = process.argv.includes("--stats")

/* ── The transcript ─────────────────────────────────────────────────────────
 *
 * It returns the WHOLE conversation every frame and lets the TUI diff the
 * array: only the lines that changed are rewritten, and everything above the
 * viewport is inert by construction (`firstChanged < prevViewportTop` is the
 * only path that would touch it, and finalized lines never change).
 */
class TranscriptComponent implements Component {
  // The collapsed tool line prints "· ctrl+o" and the fold hint prints "⌃T" —
  // promises the transcript makes on screen, so this client has to keep them.
  showThoughts = true
  showTools = false
  hasThoughts = false

  constructor(private getState: () => RoomState) {}

  invalidate(): void {}

  render(width: number): string[] {
    const state = this.getState()
    const w = Math.max(20, width - 2)
    const { lines, hasThoughts } = transcriptLines(
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
    this.hasThoughts = hasThoughts
    // pi-tui THROWS if a rendered line exceeds the width — the invariant the
    // Ink layer enforces silently with wrap="truncate-end". Same rule, but a
    // hard error instead of a cropped table nobody notices.
    return lines.map((l) => " " + truncateToWidth(paint(l) + (l.cursor ? chalk.yellow(" ▌") : ""), w))
  }
}

/** One-line chrome: room, roster, who is running. A placeholder for the real
 *  RosterStrip / RoomTabs / StatusBar, which land in Phase 1 — its job here is
 *  to hold the POSITION, below the transcript, which is the load-bearing part. */
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
    return [chalk.dim("─".repeat(Math.max(0, width))), truncateToWidth(head, width)]
  }
}

/** Stats line — the point of the migration made visible while you use it.
 *  `fullRedraws` is pi-tui's own counter: every increment is a frame that had
 *  to clear the screen AND the scrollback. Gate 1 of every phase is that it
 *  stays at 1 (the first render) through an entire streaming turn. */
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
  // Count what actually reaches the terminal — the number that decides whether
  // a phase regressed. Ink's write path erases and rewrites the whole frame on
  // every token (log-update.js: `eraseLines(previousLineCount) + output`).
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

  // Layout order is LOAD-BEARING, and it is the migration's sharpest finding.
  // Mutating chrome ABOVE the transcript sits at a line index that never grows,
  // so every roster change rewrites a line that scrolled above the viewport
  // long ago — and pi-tui answers that with a full redraw that clears the
  // scrollback (`firstChanged < prevViewportTop`). Measured: header on top → a
  // full redraw per turn; header below → one, ever.
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

  // ⌃O / ⌃T. An input listener runs BEFORE the focused component, so the Editor
  // never sees these — the same arbitration Ink gave us for free by having
  // CommandLine ignore ctrl-chords.
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
