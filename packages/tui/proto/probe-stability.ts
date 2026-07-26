#!/usr/bin/env -S npx tsx
// Does a finalized line ever change?
//
//   npx tsx packages/tui/proto/probe-stability.ts --server http://localhost:5399
//
// The whole native-scrollback bet rests on one property: once a line has
// scrolled above the viewport it is never rewritten. pi-tui enforces that
// literally — `firstChanged < prevViewportTop` falls back to a full redraw that
// clears the screen AND the scrollback (`\x1b[2J\x1b[H\x1b[3J`). So a single
// unstable line high in the transcript destroys the history it was supposed to
// preserve.
//
// This logs, for every state change, the FIRST line index that differs and both
// versions of it. Anything that isn't "appended at the end" is a migration bug.

import { createRoomStore, preloadRoomState } from "@pipeline-moe/client-core"
import { nodeEventSourceFactory } from "../src/nodeEventSource"
import { transcriptLines, paint, type Line } from "./lines"

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const apiBase = arg("--server", "http://localhost:5399")
const roomId = arg("--room", "default")
const WIDTH = Number(arg("--cols", "108"))

const render = (s: ReturnType<typeof store.getSnapshot>): string[] =>
  transcriptLines(
    {
      messages: s.messages,
      roster: s.roster,
      streaming: s.streaming,
      liveReasoning: s.liveReasoning,
      liveActivity: s.liveActivity,
      liveParts: s.liveParts,
      reasoningActive: s.reasoningActive,
      receipts: s.receipts,
    },
    WIDTH,
  ).map((l: Line) => paint(l))

const initialState = await preloadRoomState(apiBase, roomId).catch(() => undefined)
const store = createRoomStore({
  apiBase,
  roomId,
  eventSourceFactory: nodeEventSourceFactory,
  ...(initialState ? { initialState } : {}),
})

let previous: string[] = []
let renders = 0
let appendOnly = 0
const rewrites: Array<{ index: number; before: string; after: string }> = []

store.subscribe(() => {
  const next = render(store.getSnapshot())
  renders++
  let first = -1
  const max = Math.max(next.length, previous.length)
  for (let i = 0; i < max; i++) {
    if (previous[i] !== next[i]) {
      first = i
      break
    }
  }
  if (first === -1) {
    previous = next
    return
  }
  // Appended at the end = the property holds. Anything else rewrites history.
  if (first >= previous.length) appendOnly++
  else {
    rewrites.push({
      index: first,
      before: JSON.stringify(previous[first] ?? "").slice(0, 120),
      after: JSON.stringify(next[first] ?? "").slice(0, 120),
    })
  }
  previous = next
})

store.start()

const seconds = Number(arg("--seconds", "45"))
setTimeout(() => {
  console.log(`\nrenders: ${renders}   append-only: ${appendOnly}   history rewrites: ${rewrites.length}`)
  const byIndex = new Map<number, { before: string; after: string; n: number }>()
  for (const r of rewrites) {
    const e = byIndex.get(r.index)
    if (e) e.n++
    else byIndex.set(r.index, { before: r.before, after: r.after, n: 1 })
  }
  for (const [index, e] of [...byIndex.entries()].sort((a, b) => a[0] - b[0]).slice(0, 12)) {
    console.log(`\n  line ${index} rewritten ×${e.n}\n    before ${e.before}\n    after  ${e.after}`)
  }
  process.exit(0)
}, seconds * 1000)
