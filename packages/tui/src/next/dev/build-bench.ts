#!/usr/bin/env -S npx tsx
// What does it cost to BUILD one frame? (docs/tui-next-optimizations.md, entry 0)
//
//   npx tsx packages/tui/src/next/dev/build-bench.ts [--cols 120] [--reps 30]
//
// Not to be confused with `bench.ts`, which measures bytes written to the
// terminal and compares two renderers. This one never renders: it measures the
// CPU of assembling the `string[]` that `TranscriptView.render` returns, which
// is the cost `bench.ts` deliberately excludes and no gate can see. Gate 1
// stays green at 38ms a frame.
//
// The bill it prices: pmoe-next has no scroll state by design, so the
// transcript component returns EVERY line of the conversation every frame and
// lets pi-tui diff the array. The diff is cheap; building the array is not, and
// it happens once per store change — i.e. per streaming token.
//
// Four numbers, because the optimization needs all four to be judged:
//
//   BILL    the per-frame build, warm markdown cache — the number that grows
//           with every day of use.
//   FLOOR   the same frame if every finalized message handed back the identical
//           string array it handed back last frame: rebuild the live tail,
//           concatenate the rest by reference. This is the target, not zero.
//   COLD    the same build with the markdown cache empty. The gap BILL→COLD is
//           what a cache miss costs, and therefore what entry 4's resize pays.
//   RESIZE  a 120→56→120 round trip. `markdown.ts` keys both caches on a single
//           `cacheWidth` and clears wholesale, so the return to a width already
//           rendered re-parses the whole conversation a second time. Entry 4
//           claims keying by (text, width) would make the trip back free; the
//           RESIZE-vs-COLD comparison is what would prove it.
//
// Reported as MEDIAN of --reps, with min. Not the mean: a GC pause lands in one
// rep and drags an average somewhere no frame ever actually was.

import { readFileSync } from "node:fs"
import { truncateToWidth } from "@earendil-works/pi-tui"
import chalk from "chalk"
import type { Message, RosterItem } from "@pipeline-moe/client-core"
import { transcriptLines, paint, type Line } from "../../transcript-lines"

function num(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const COLS = num("--cols", 120)
const REPS = num("--reps", 30)
/** `--session sessions/default/<id>.json` replaces the synthetic fixture with a
 *  real transcript. Prefer it: the synthetic conversation is a guess about
 *  message size and markdown density, and both drive the cost. A saved session
 *  is ground truth the same way `presets/` is for the schema. */
const SESSION = arg("--session")
/** The width the resize probe bounces off. Narrow enough to force a real
 *  reflow, wide enough to stay a plausible terminal. */
const NARROW = num("--narrow", 56)

/* ── The fixture ─────────────────────────────────────────────────────────── */
//
// Markdown-heavy assistant turns, because that is what the transcript actually
// carries and markdown is where the cost is. Deterministic: same conversation
// every run, so two runs of this file are comparable.

const SYNTHETIC_ROSTER: RosterItem[] = [
  { id: "planner", name: "Planner", color: "#4A90D9", icon: "📋", active: true } as RosterItem,
  { id: "builder", name: "Builder", color: "#EF9F27", icon: "🔨", active: true } as RosterItem,
]

const LOREM =
  "The registry rebuilds the seat whenever the roster changes, so the prompt and the toolset " +
  "flip together and never one without the other. That invariant is why the note is injected " +
  "from the same predicate that builds the tools."

function assistantTurn(i: number): string {
  return [
    `## Turn ${i}`,
    "",
    LOREM,
    "",
    `- \`seat-${i}\` rebuilt from the predicate`,
    `- **${i} handoffs** observed, none gated`,
    "",
    "```ts",
    `const seat${i} = registry.rebuild({ roster, gates: ${i} })`,
    "```",
    "",
    LOREM,
  ].join("\n")
}

/** A saved session's transcript, if `--session` was given. Its entries already
 *  carry the `Message` fields the transcript reads (index, author, authorName,
 *  text, activity, reasoning) — it is what the server persists. */
const SAVED: { transcript: Message[]; personas?: RosterItem[] } | undefined = SESSION
  ? JSON.parse(readFileSync(SESSION, "utf8"))
  : undefined

function history(n: number): Message[] {
  if (SAVED) return SAVED.transcript.slice(0, n)
  const out: Message[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      index: i,
      author: i % 2 === 0 ? "user" : "builder",
      authorName: i % 2 === 0 ? "You" : "Builder",
      text: i % 2 === 0 ? `Message ${i}: what changed in the seat runtime?` : assistantTurn(i),
    } as Message)
  }
  return out
}

const roster: RosterItem[] = SAVED?.personas?.length ? SAVED.personas : SYNTHETIC_ROSTER

/** The sizes measured. With a real session the interesting points are its own
 *  length and the way there — extrapolating past it would re-introduce exactly
 *  the invented conversation this flag exists to replace. */
const SIZES: number[] = SAVED
  ? [...new Set([10, 25, 50, 100, SAVED.transcript.length])]
      .filter((n) => n <= SAVED.transcript.length)
      .sort((a, b) => a - b)
  : [20, 100, 200, 600]

/** The streaming tail — one agent mid-reply. Every measurement below carries
 *  one, because a frame with no live message is not a frame anyone waits on. */
const TAIL = (`${LOREM} `).repeat(3)

function input(messages: Message[]): Parameters<typeof transcriptLines>[0] {
  return {
    messages,
    roster,
    streaming: { [roster[0]?.id ?? "builder"]: TAIL },
    liveReasoning: {},
    liveActivity: {},
    reasoningActive: {},
    receipts: {},
  }
}

/* ── The frame build, as TranscriptView.render does it ───────────────────── */
//
// Copied from next/main.ts rather than imported: the real one needs a store, a
// TUI and an ImageStrip. The image branch is omitted — the fixture has no
// attachments, so in the real client that branch is a `l.images?.length` miss
// per line, which is not where 38ms comes from.

function buildFrame(messages: Message[], width: number): string[] {
  const w = Math.max(20, width - 2)
  const { lines } = transcriptLines(input(messages), w, { showThoughts: true, showTools: false })
  return paintLines(lines, w)
}

function paintLines(lines: Line[], w: number): string[] {
  const out: string[] = []
  for (const l of lines) {
    out.push(` ${truncateToWidth(paint(l) + (l.cursor ? chalk.yellow(" ▌") : ""), w)}`)
  }
  return out
}

/* ── Timing ──────────────────────────────────────────────────────────────── */

interface Timing {
  median: number
  min: number
}

function time(reps: number, fn: () => unknown): Timing {
  return timeStep(reps, () => {}, fn)
}

/** Clock `fn` only, with `setup` run before each rep and excluded.
 *
 *  Not a convenience: the markdown caches make every measurement here depend on
 *  what ran immediately before it, so a leg cannot be priced by subtracting two
 *  separately-timed loops. Doing exactly that is what made the first run of this
 *  bench report a return leg LONGER than the round trip containing it — the
 *  subtrahend loop repeated one width and so measured a warm build, while the
 *  same call inside the minuend loop was cold. */
function timeStep(reps: number, setup: () => void, fn: () => unknown): Timing {
  const samples: number[] = []
  for (let i = 0; i < reps; i++) {
    setup()
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  return { median: samples[Math.floor(samples.length / 2)], min: samples[0] }
}

const ms = (n: number): string => n.toFixed(3).padStart(8)

/** Force both markdown caches to drop. `resetOnResize` clears them whenever the
 *  width differs from the last one seen, so a throwaway render at another width
 *  is the supported way to get a cold cache without exporting a test hook. */
function dropMarkdownCache(width: number): void {
  buildFrame(history(1), width === 1000 ? 999 : 1000)
}

/* ── 1. THE BILL ─────────────────────────────────────────────────────────── */

console.log(`
Frame build cost — ${COLS} columns, median of ${REPS} reps, one streaming tail.
Fixture: ${SESSION ? `${SESSION} (${SAVED?.transcript.length} real messages)` : "synthetic"}.
Every row is ONE frame, i.e. what one streamed token costs before a single byte
reaches the terminal.

  messages     rows      BILL(warm)        COLD(no cache)     miss cost`)

const bill: Record<number, Timing> = {}
for (const n of SIZES) {
  const messages = history(n)
  const rows = buildFrame(messages, COLS).length

  // Warm: the cache holds every finalized message at this width. The live tail
  // still re-parses each frame, which is correct — it changes each frame.
  buildFrame(messages, COLS)
  const warm = time(REPS, () => buildFrame(messages, COLS))
  bill[n] = warm

  const cold = time(REPS, () => {
    dropMarkdownCache(COLS)
    buildFrame(messages, COLS)
  })

  console.log(
    `  ${String(n).padStart(8)}  ${String(rows).padStart(7)}   ${ms(warm.median)} ms` +
      ` (min ${ms(warm.min)})   ${ms(cold.median)} ms   ${(cold.median / warm.median).toFixed(1)}×`,
  )
}

/* ── 2. THE FLOOR ────────────────────────────────────────────────────────── */
//
// What the frame would cost if finalized messages were memoized: their painted
// lines already exist and come back by reference, so the frame is "rebuild the
// tail, then concatenate". Split in two, because they answer different
// questions — the concat alone is the ceiling on the whole idea, and the
// realistic target is concat + tail.

console.log(`
Floor — what the same frame costs if finalized messages hand back the SAME
string array each time (entry 0's fix). The concat is the ceiling; concat+tail
is the realistic target.

  messages     rows      concat only     concat + live tail     vs BILL`)

const liveOnly = (messages: Message[], w: number): Line[] =>
  transcriptLines({ ...input(messages), messages: [] }, w, {
    showThoughts: true,
    showTools: false,
  }).lines

for (const n of SIZES) {
  const messages = history(n)
  const w = COLS - 2
  const full = buildFrame(messages, COLS)

  // The frozen head is every row the live block does not own. The split is
  // approximate at the seam (the live block's header depends on what precedes
  // it), which does not matter here: what is being priced is the cost of
  // concatenating this MANY existing references, not their contents.
  const tailLines = liveOnly(messages, w)
  const head = full.slice(0, Math.max(0, full.length - tailLines.length))
  const prebuiltTail = paintLines(tailLines, w)

  // Ceiling: nothing is rebuilt at all.
  const concat = time(REPS, () => [...head, ...prebuiltTail].length)

  // Target: the live tail is rebuilt from its text every frame — the part no
  // cache can remove, because it is the part that changed — then concatenated.
  const target = time(REPS, () => [...head, ...paintLines(liveOnly(messages, w), w)].length)

  console.log(
    `  ${String(n).padStart(8)}  ${String(full.length).padStart(7)}   ${ms(concat.median)} ms` +
      `     ${ms(target.median)} ms      ${(bill[n].median / target.median).toFixed(0)}× slower today`,
  )
}

/* ── 3. RESIZE (entry 4) ─────────────────────────────────────────────────── */

console.log(`
Resize — ${COLS}→${NARROW}→${COLS}. markdown.ts keys both caches on a single
cacheWidth and clears on any change, so the trip BACK to a width already
rendered re-parses everything. A (text,width) key would make the return free;
the gap between the two columns is what that change would buy.

  messages     round trip      of which the return leg`)

for (const n of SIZES) {
  const messages = history(n)

  // A third of the reps: each one is three cold builds, and at 600 messages
  // that is two seconds of wall clock per rep.
  const reps = Math.max(5, Math.floor(REPS / 3))
  const trip = time(reps, () => {
    buildFrame(messages, COLS)
    buildFrame(messages, NARROW)
    buildFrame(messages, COLS)
  })

  // The return leg alone: arriving at COLS is only a "return" if a NARROW
  // render just evicted the cache, so the eviction is the setup and only the
  // way back is on the clock.
  const back = timeStep(
    reps,
    () => {
      buildFrame(messages, NARROW)
    },
    () => buildFrame(messages, COLS),
  )

  console.log(
    `  ${String(n).padStart(8)}   ${ms(trip.median)} ms      ${ms(back.median)} ms` +
      `   (${((back.median / trip.median) * 100).toFixed(0)}% of the trip)`,
  )
}

console.log(`
Read it as: BILL is what every token costs today and it grows with the
conversation; the floor says how much of that is recoverable; the resize row
says how much a window drag costs on top. Numbers are this machine, this
fixture — re-run before and after any change to entry 0 or 4 rather than
comparing to a number written in a doc.
`)
