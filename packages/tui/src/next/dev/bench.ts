#!/usr/bin/env -S npx tsx
// What does one streaming token cost, on each renderer?
//
//   npx tsx packages/tui/src/next/dev/bench.ts [--history 40] [--tokens 200] [--rows 45] [--cols 120]
//
// Both renderers are given the SAME line array (src/transcript-lines.ts, the
// one BOTH clients render — that is what makes this apples-to-apples) and the same
// synthetic turn: a conversation of N finalized messages, then one agent
// streaming M tokens into the tail. Neither writes to a real terminal — stdout
// is a counting sink — so the number is bytes-the-terminal-would-have-to-parse,
// which is the thing you feel over tmux and ssh.
//
// The hypothesis under test is not "pi-tui is faster". It is that Ink's cost is
// proportional to the SCREEN and pi-tui's to the CHANGE:
//   ink/build/log-update.js  →  write(eraseLines(previousLineCount) + output)
//   pi-tui/tui.ts            →  write(only lines firstChanged..lastChanged)

import { TUI, type Component, type Terminal } from "@earendil-works/pi-tui"
import { truncateToWidth } from "@earendil-works/pi-tui"
import type { Message, RosterItem } from "@pipeline-moe/client-core"
import { transcriptLines, paint, type Line } from "../../transcript-lines"

function num(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback
}

const HISTORY = num("--history", 40)
const TOKENS = num("--tokens", 200)
const ROWS = num("--rows", 45)
const COLS = num("--cols", 120)

/* ── The fixture ─────────────────────────────────────────────────────────── */

const roster: RosterItem[] = [
  { id: "planner", name: "Planner", color: "#4A90D9", icon: "📋", active: true } as RosterItem,
  { id: "builder", name: "Builder", color: "#EF9F27", icon: "🔨", active: true } as RosterItem,
]

const LOREM =
  "The registry rebuilds the seat whenever the roster changes, so the prompt and the toolset " +
  "flip together and never one without the other. That invariant is why the note is injected " +
  "from the same predicate that builds the tools."

function history(n: number): Message[] {
  const out: Message[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      index: i,
      author: i % 2 === 0 ? "user" : "builder",
      authorName: i % 2 === 0 ? "You" : "Builder",
      text: i % 2 === 0 ? `Message ${i}: what changed in the seat runtime?` : `${LOREM}\n\n- point ${i}\n- point ${i + 1}`,
    } as Message)
  }
  return out
}

const MESSAGES = history(HISTORY)

/** The line array both renderers are handed, for a stream of `chars` chars. */
function linesAt(chars: number): Line[] {
  const streamed = (LOREM + " ").repeat(20).slice(0, chars)
  return transcriptLines(
    {
      messages: MESSAGES,
      roster,
      streaming: streamed ? { builder: streamed } : {},
      liveReasoning: {},
      liveActivity: {},
      reasoningActive: {},
      receipts: {},
    },
    COLS - 2,
  ).lines
}

const paintAll = (ls: Line[]): string[] => ls.map((l) => truncateToWidth(paint(l), COLS - 2))

/* ── Renderer A: pi-tui ──────────────────────────────────────────────────── */

class Frame implements Component {
  lines: string[] = []
  invalidate(): void {}

  render(): string[] {
    return this.lines
  }
}

function benchPiTui(): { bytes: number; writes: number; fullRedraws: number } {
  let bytes = 0
  let writes = 0
  const terminal: Terminal = {
    get columns() {
      return COLS
    },
    get rows() {
      return ROWS
    },
    start: () => {},
    stop: () => {},
    write: (data: string) => {
      bytes += Buffer.byteLength(data)
      writes += 1
    },
    onResize: () => () => {},
    onData: () => () => {},
    moveCursor: () => {},
    hideCursor: () => {},
    showCursor: () => {},
  } as unknown as Terminal

  const tui = new TUI(terminal, false)
  const frame = new Frame()
  tui.addChild(frame)

  // Prime: the first render is the whole conversation, once. Everything after
  // is the steady state we are measuring.
  frame.lines = paintAll(linesAt(0))
  ;(tui as unknown as { doRender: () => void }).doRender()
  const primed = bytes

  for (let t = 1; t <= TOKENS; t++) {
    frame.lines = paintAll(linesAt(t * 5))
    ;(tui as unknown as { doRender: () => void }).doRender()
  }
  return { bytes: bytes - primed, writes: writes - 1, fullRedraws: tui.fullRedraws }
}

/* ── Renderer B: Ink's write path ────────────────────────────────────────── */
//
// Not Ink itself (React + reconciler would measure React, not the write path).
// This is `ink/build/log-update.js` verbatim — the code Ink calls for every
// frame that is not <Static> and not taller than the screen:
//
//     stream.write(ansiEscapes.eraseLines(previousLineCount) + output)
//
// eraseLines(n) = n × (eraseLine + cursorUp), minus the last cursorUp, + cursorLeft.

function eraseLines(count: number): string {
  let clear = ""
  for (let i = 0; i < count; i++) {
    clear += "\x1b[2K" + (i < count - 1 ? "\x1b[1A" : "")
  }
  if (count) clear += "\x1b[G"
  return clear
}

function benchInk(): { bytes: number; writes: number; clears: number } {
  let bytes = 0
  let writes = 0
  let clears = 0
  let previousLineCount = 0
  let lastOutput = ""

  const write = (data: string): void => {
    bytes += Buffer.byteLength(data)
    writes += 1
  }

  const frame = (lines: string[]): void => {
    // Ink renders the whole app; the transcript is windowed to the screen, so
    // the frame is at most the terminal height. That is Ink's ceiling AND its
    // floor: it always writes a full screen.
    const windowed = lines.slice(Math.max(0, lines.length - (ROWS - 8)))
    const output = windowed.join("\n")
    if (output === lastOutput) return
    if (windowed.length >= ROWS) {
      // ink.js: outputHeight >= rows → clearTerminal, every frame.
      write("\x1b[2J\x1b[3J\x1b[H" + output)
      clears += 1
    } else {
      write(eraseLines(previousLineCount) + output + "\n")
    }
    previousLineCount = windowed.length + 1
    lastOutput = output
  }

  frame(paintAll(linesAt(0)))
  const primed = bytes
  const primedWrites = writes

  for (let t = 1; t <= TOKENS; t++) frame(paintAll(linesAt(t * 5)))
  return { bytes: bytes - primed, writes: writes - primedWrites, clears }
}

/* ── Report ──────────────────────────────────────────────────────────────── */

const total = linesAt(TOKENS * 5).length
const a = benchPiTui()
const b = benchInk()
const fmt = (n: number): string => (n / 1024).toFixed(1).padStart(9) + " KiB"

console.log(`
Streaming ${TOKENS} tokens into a ${HISTORY}-message conversation (${total} display lines)
Terminal ${COLS}×${ROWS}. Bytes written to the terminal, steady state only (first render excluded).

  pi-tui   ${fmt(a.bytes)}   ${String(a.writes).padStart(5)} writes   ${Math.round(a.bytes / TOKENS)
  .toString()
  .padStart(6)} B/token   full redraws: ${a.fullRedraws}
  Ink      ${fmt(b.bytes)}   ${String(b.writes).padStart(5)} writes   ${Math.round(b.bytes / TOKENS)
  .toString()
  .padStart(6)} B/token   full clears:  ${b.clears}

  ratio    ${(b.bytes / Math.max(1, a.bytes)).toFixed(1)}× more bytes through Ink's write path
`)
