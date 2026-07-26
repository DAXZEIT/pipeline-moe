# Pricing the pi-tui migration — what the prototype found

`docs/tui-lessons-from-pi.md` parked backlog item #1 ("native scrollback for the
transcript") on 2026-07-19 with a note: *a throwaway prototype (pi-tui transcript
fed by client-core) would price the migration honestly*. This is that prototype's
report. Code: `packages/tui/proto/` (throwaway — nothing in `src/` imports it).

Read on disk at `@earendil-works/pi-tui@0.82.1`. The published `.js.map` files
carry `sourcesContent`, so the numbers below cite the original TypeScript, not a
build.

## Why pi feels different, in one paragraph

pi does not scroll. It **prints**. No alternate screen (`1049` appears nowhere in
pi-tui) and no mouse tracking at all (no `1006`/`1002`/`1003`/`1007`) — the app
never reads the wheel. The conversation grows into the terminal's own scrollback:
`buffer += "\r\n".repeat(scroll)` (`tui.ts:1481`) scrolls the terminal itself,
and `viewportTop` tracks where the visible window sits inside an ever-growing
logical buffer. Everything above the viewport is inert by construction — the only
code path that would touch it is `if (firstChanged < prevViewportTop)`
(`tui.ts:1459`), which gives up and does a full redraw. So: native wheel, native
selection over the whole history, terminal search, unbounded history, and a
render cost independent of conversation length. None of that is reachable by
improving a scroller.

## The number

`packages/tui/proto/bench.ts` hands **the same line array** to both write paths —
Ink's is `ink/build/log-update.js` verbatim (`write(eraseLines(previousLineCount)
+ output)`), pi-tui's is the real `TUI` driven by a counting `Terminal`. Steady
state only; the first render is excluded. 200 streamed tokens into a 40-message
conversation:

| terminal | pi-tui | Ink | ratio |
|---|---|---|---|
| 120×30 | 99 B/token | 2 256 B/token | 22.8× |
| 120×45 | 99 B/token | 3 893 B/token | 39.4× |
| 120×60 | 99 B/token | 5 436 B/token | 55.0× |

The shape matters more than the ratio: **pi-tui's cost is proportional to the
change, Ink's to the screen.** A 300-message conversation measures identically to
a 40-message one on both — but the bigger your terminal, the worse Ink gets,
which is the opposite of the intuition. Ink writes a full screen per frame
because `log-update` erases the previous frame entirely before writing the next.

Confirmed live, not just in the bench: the prototype against a real room over two
agent turns reported **144 frames, 60.3 KiB, 429 B/frame, 1 full redraw**.

## The finding that actually costs us: chrome must move to the bottom

The append-only property has one enemy, and we are built on top of it.

Mutating chrome placed ABOVE the transcript sits at a line index that never
grows. So every roster change rewrites a line that scrolled above the viewport
long ago, and pi-tui answers that with a full redraw — which clears the screen
**and the scrollback** (`\x1b[2J\x1b[H\x1b[3J`). Measured, same room, same turns:

    header above the transcript   →  4 full redraws (one per turn)
                                     PI_DEBUG_REDRAW: "firstChanged < viewportTop (0 < 25)"
    header below the transcript   →  1 full redraw (the first render), 98 lines
                                     of native scrollback retained

Our Ink layout puts `RoomTabs`, `RosterStrip`, `TaskSummary` and `HeaderDivider`
above the conversation. **All of it has to move below.** pi puts its status line
at the bottom; the reason turns out to be structural, not aesthetic.

`packages/tui/proto/probe-stability.ts` measures the same property directly — for
every state change it reports the first line index that differs. Two rewrites per
turn are ours and are unavoidable at the tail (`── 🔨 Builder ──` gains its
duration, `💭 thinking…` becomes `💭 thought` when the turn lands); both sit near
the bottom of a turn's block, so they only bite if a single turn is taller than
the screen.

## What survives untouched

- **`@pipeline-moe/client-core`** — the store, the SSE reducer, the types: zero
  changes. The prototype imports `createRoomStore` / `preloadRoomState` /
  `nodeEventSourceFactory` and subscribes `tui.requestRender`. That was the
  strategic bet and it paid.
- **The transcript renderer.** `proto/lines.ts` is `Transcript.tsx` with React
  removed and nothing else: same `markdown.ts`, `activity.ts`, `parts.ts`,
  `transcript-format.ts`, same windowing, same thought gutter. It already *was*
  a `render(width): string[]` — Ink was only painting the result.
- **What disappears**: `offset`, `maxOffset`, `pageRef`, PgUp/PgDn, `⌃↑`/`⌃↓`,
  `reservedRows` and its four-term arithmetic, `bodyHeight`, the scroll hint
  footer. The scroll code is not ported; it is deleted.

## Not a finding: grouped tool calls on an old room

First live test showed `🔧 7 tool calls · ctrl+o` instead of the chronological
layout — which looks like the prototype losing `docs/interleaved-turns.md`. It is
not. Those entries were recorded **2026-07-22 01:21–01:25**, three days before
the segmenter landed (`8c98cab`, 2026-07-25 21:35), so they carry no `parts` and
get the documented grouped fallback. Verified on a fresh room: a tool-using turn
persists 4 parts in arrival order (reasoning → tool → reasoning → text) and the
prototype renders them interleaved, tool line in place.

The real gap the test exposed was smaller and is now closed: `ctrl+o` / `ctrl+t`
were advertised in the rendered lines but not wired. `tui.addInputListener` runs
before the focused component, so the Editor never sees the chords — the same
arbitration Ink gave us for free by having `CommandLine` ignore ctrl-chords.

## What the prototype deliberately did not port

Overlays, room tabs, the roster strip's context gauges, slash commands and the
command palette, images, notices. That is the migration's real bulk. Known costs:

- **Overlays** are a rewrite, not a port: pi-tui composites them into the frame
  (`compositeOverlays`) with 9 anchors and a stack, against our single-overlay
  Ink model. Strictly more capable — it would also delete the `picking`
  workaround in `RoomForm.tsx` — but every overlay component changes shape.
- **Every line must fit the width or pi-tui throws** (with a crash log of all
  lines). Same invariant our `wrap="truncate-end"` enforces silently; the
  prototype calls `truncateToWidth` explicitly. Loud beats silent, but every
  component has to obey it.
- **`Component` requires `invalidate()`** alongside `render(width)`.
- **Resize is a full redraw** (wrap invalidation) and clears the scrollback.
  Unavoidable in this architecture — claude_code pays it too.

## What we would gain beyond scrolling

- **Their `Editor`** (~1900 lines): multiline, history with draft preservation,
  kill-ring, undo, paste markers, autocomplete, grapheme segmentation. We have
  re-implemented three of those by hand already (`prompt-history.ts`,
  `paste-markers.ts`, `multiline-input.ts`).
- **The real hardware cursor** (`positionHardwareCursor`, `tui.ts:1632`) —
  native blink, user's cursor shape, correct IME placement. We paint an inverse
  block because Yoga fragments nested `<Text>`.
- **The kitty keyboard protocol**, which `cli.tsx:26` currently *pops* (`\x1b[<u`)
  because Ink cannot parse CSI-u. pi enables it with flags 1|2|4 and falls back
  to `modifyOtherKeys`. That is where a real Shift+⏎ comes from, instead of the
  `` ` ``+⏎ workaround in `multiline-input.ts`.
- **`StdinBuffer`** — accumulates until an escape sequence is complete, so a
  split `\x1b[<35;20;5m` is never read as keystrokes. Exactly the class of bug
  the CSI-u incident cost us.

## How big is the current TUI, really

dax: *"un découpage propre de chaque fonctionnalité de mon TUI actuel serait déjà
un boulot monstre, non ?"* — counted rather than estimated, on
`packages/tui/src` at `86b2598`.

**7 080 lines** of source across 46 files, plus **1 797 lines** of tests in 18
files. 35 slash commands, 11 overlays, 130 commits over 26 days (2026-06-30 →
2026-07-26).

The split that decides everything:

| | lines | share |
|---|---|---|
| framework-free (no `ink`, no `react` import) | 2 696 | 38 % |
| Ink-coupled | 4 384 | 62 % |

And inside those 4 384, four very different fates:

**Survives verbatim — ~2 420 lines.** Every framework-free module except the
input helpers that die with `CommandLine`. Plus **the entire test suite**: not
one of the 18 files renders Ink, they all test pure modules. 1 797 lines of
tests cross the migration untouched.

**Deleted, not ported — ~1 030 lines.** `CommandLine.tsx` (571) is replaced by
pi-tui's `Editor`, and its three hand-built companions die with it —
`multiline-input.ts` (148), `paste-markers.ts` (61), `prompt-history.ts` (66),
all of which re-implement what their Editor already does. `useTerminalSize` (30)
and `useRoomStore` (30) become a TUI property and a `store.subscribe`. Most of
`cli.tsx` — alt screen, the DEC 2026 wrapper, the CSI-u pop — is pi-tui's
`terminal.ts`. Plus `Transcript.tsx`'s scroll block.

**Mechanical, and they shrink — ~700 lines.** `RosterStrip.tsx` is 34 lines of
Ink painting over `roster-strip.ts`, which is 229 framework-free lines that
already return pre-painted ANSI strings. Its port is about ten lines. Same shape
for `TaskSummary`, `RoomTabs`, `Notices`, `HeaderDivider`, `StatusBar`. And
`Transcript.tsx` is done: `proto/lines.ts` is the whole thing, proven live.

**The real work — ~2 830 lines.** The 11 overlays (2 209) and `App.tsx`'s wiring
(621). But even that splits:

- ~510 lines are *replaced by library components*, not ported: `SelectOverlay`
  (114), `TextInputOverlay` (95), `PresetPickerOverlay` (143), `TasksOverlay`
  (77), `LineupOverlay` (80) all become pi-tui's `SelectList` (with fuzzy filter
  built in), `Input`, and `Box`/`Text`.
- ~1 340 lines are genuine forms: `PresetComposerOverlay` (613, 19 `useState`),
  `RoomForm` (326), `EditAgentForm` (206), `AgentForm` (197). This is the
  irreducible cost. `RoomForm`'s `picking` hack disappears — real overlay
  stacking is what it was faking.
- `GraphOverlay` (223) is mostly string generation and ports cleanly.

**So: yes, big — but ~2 800 lines of true rewrite out of 7 080, and a third of
that is one file.** The "monstrous" framing assumes every feature is re-derived;
38 % of the code never learns which renderer it is under, and that was the point
of extracting client-core in the first place.

### It does not have to be a big bang

`packages/tui` already publishes one bin (`pmoe`). A second entry point on the
same `client-core` — the prototype IS that entry point — lets the two clients
coexist: migrate overlay by overlay, flip the default when parity lands, delete
the Ink tree last. Nothing about the server, the protocol, or the store changes,
which is exactly what the 38 % measures.

## Verdict

The transcript half of the migration is cheap and already proven: client-core
untouched, the renderer already portable, the scroll code deleted rather than
rewritten. The cost is concentrated in overlays and in the layout inversion —
chrome to the bottom — which is a visible product change, not just an internal
one.

## How to run it

    npx tsx packages/tui/proto/bench.ts [--history 40] [--tokens 200] [--rows 45]
    npx tsx packages/tui/proto/main.ts --server http://localhost:5300 --stats
    npx tsx packages/tui/proto/probe-stability.ts --server http://localhost:5300

`PI_DEBUG_REDRAW=1` makes pi-tui log every full redraw and its reason to
`~/.pi/agent/pi-debug.log` — the fastest way to catch a line that rewrites
history.

One caveat on the prototype's own wiring: `@earendil-works/pi-tui` is not a
declared dependency here. It resolves because npm hoists it out of
`pi-coding-agent`, which we do depend on. Fine for a throwaway (`proto/` is
outside `packages/tui`'s published `files`); a real migration declares it.
