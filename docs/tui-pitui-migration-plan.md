# Migrating the TUI to pi-tui — execution plan

Prerequisite reading: `docs/tui-pitui-prototype.md` (what was measured and why),
`docs/tui-lessons-from-pi.md` (the original comparison). This plan turns that
inventory into an order of operations.

The measured starting point, at `2baa649`: 7 080 source lines / 46 files, 1 797
test lines / 18 files, 35 slash commands, 11 overlays. 38 % of the source
imports neither `ink` nor `react`; ~2 830 lines are a genuine rewrite.

## The shape of the migration

**Two clients on one `client-core`, never a big bang.** `packages/tui` keeps
publishing `pmoe` (Ink) untouched while a second bin `pmoe-next` (pi-tui) grows
beside it. Both import the same store, the same types, the same pure modules.
The default flips only when parity is reached; the Ink tree is deleted last.

This is not caution for its own sake — it is the only way to keep a client you
actually use every day while the other one is half-built.

    packages/tui/
      src/            Ink client — frozen except for shared-module extractions
      src/next/       pi-tui client — grows phase by phase
      src/<pure>.ts   framework-free modules, imported by BOTH
      src/next/dev/   bench + stability probe (excluded from the published files)

## The gates

Every phase ends by re-running these. They are what make each step reversible
and each regression visible. A phase is not done until all five hold.

1. **`fullRedraws === 1`** through a complete streaming turn, measured with
   `--stats` on a live room. Any increase means a line above the viewport was
   rewritten, which means the terminal scrollback was cleared — the entire
   reason for the migration, silently lost.
2. **No history rewrite.** `src/next/dev/probe-stability.ts` reports the first
   differing line index per state change. Nothing may change above the viewport
   except the two known turn-finalization rewrites (header rule gains its
   duration, `💭 thinking…` becomes `💭 thought`) — and Phase 1 is where those
   two stop being tolerated, see below.
3. **Every rendered line fits the width.** pi-tui throws otherwise, with a crash
   log. Cheap to satisfy (`truncateToWidth`), fatal to forget.
4. **The pure test suite stays green.** 1 797 lines, 18 files, zero Ink. It is
   the contract between the two clients; if a migration step needs to change a
   test, the step is wrong.
5. **`packages/client-core` diff is empty.** If a phase seems to need a change
   there, stop: it means renderer detail is leaking into the protocol layer.
   (One legitimate exception is pre-approved in Phase 2 — see there.)

Verification is live, on an isolated instance: `PORT=5399` with
`WORKSPACE_DIR` **and** `SESSIONS_DIR`
pointed at a scratch dir (the manifest lives under `sessionsDir`, so setting
only the workspace still restores the real rooms).

**Never pipe the client's stdout when measuring.** A pipe hides the terminal
size, pi-tui falls back to 24 rows, and every turn then looks taller than the
viewport — which reads exactly like a gate-1 failure and is not one. Capture
with `tmux capture-pane` and read `PI_DEBUG_REDRAW=1`'s log at
`~/.pi/agent/pi-debug.log` instead. This cost one wrong measurement on
2026-07-26.

---

## Phase 0 — foundation ✅ DONE (2026-07-26)

**Goal: one transcript renderer, two clients, and a declared dependency.**

- Declare `@earendil-works/pi-tui` in `packages/tui`'s dependencies. **Done at
  `^0.82.1`.** The premise was wrong in an interesting way: it was never hoisted
  out of `pi-coding-agent` — the repo ROOT declares it, pinned exact at 0.80.6 so
  it stays in step with the pi stack the server runs. The client uses pi-tui
  alone, with no sibling to agree with, so it takes the caret; npm nests 0.82.1
  under `packages/tui`, which is what an npm install of the client gets. The two
  versions export the same API surface (verified: no additions, no removals) and
  the bench re-measures identically on 0.82.1.
- **Extract, don't copy.** Done: `src/transcript-lines.ts` is the single
  framework-free flatten, and `Transcript.tsx` (403 → 141 lines) is now a call
  site that keeps only the windowing (`offset`, `bodyHeight`), the keys that move
  it, and the Ink painting. It returns `{ lines, hasThoughts }` — `hasThoughts`
  had to come out too, since it is computed while walking the turns and the ⌃T
  hint is only honest when something can actually be folded.
- Done: `src/next/main.ts` + the `pmoe-next` bin; `bench.ts` and
  `probe-stability.ts` under `src/next/dev/`, excluded from the published
  `files`. `proto/` is gone.
- Done: `transcript-lines.test.ts`, 23 tests. The load-bearing one asserts the
  architecture's premise directly — while a live block streams, every line above
  it is byte-identical across five growth steps. The live probe measures that
  against a real server; this measures it in CI, where a regression is cheap.

**Exit — met.** Both bins run against the same room and render the same
transcript (verified live on `:5399`, 7-persona roster, interleaved turns). Gate
1: 1 full redraw across a whole streaming turn at 120×40, 58 lines of native
scrollback retained. Gate 3: `truncateToWidth` on every line, no crash log. Gate
4: 212 tests green in `packages/tui`, 1 503 across the repo. Gate 5:
`client-core` diff empty.

**Found on the way, and deliberately NOT fixed:** `wrap()` destroys leading
indentation (it splits on `" "` and rejoins with single spaces), so shell output
loses its indenting — the very thing the comment above it says markdown would do.
Verified byte-identical to the `wrap()` that already shipped, so it is a
pre-existing defect and not a migration regression. A phase is a translation, so
it is asserted as-is in the test suite with a note, and the fix belongs after
Phase 6 with the web renderer checked at the same time.

---

## Phase 1 — chrome, below the conversation

**Goal: the layout inversion, with real components.**

Port, in this order (cheapest first, and each is a thin painter over a module
that is already framework-free):

| component | Ink lines | pure module it paints |
|---|---|---|
| `HeaderDivider` | 15 | — |
| `TaskSummary` | 30 | — |
| `RosterStrip` | 34 | `roster-strip.ts` (229, already returns ANSI) |
| `RoomTabs` | 62 | — |
| `Notices` | 22 | — |
| `StatusBar` | 134 | `input-mode.ts`, `roster-stats.ts`, `transcript-format.ts` |

All of it renders **below** the transcript. This is the one visible product
change in the whole migration and it is already agreed (dax, 2026-07-26: *"le
roster en bas ça ne me dérange pas"*).

**Watch:** this is the phase most likely to break gate 1. Every one of these
mutates on agent state. If `fullRedraws` climbs, something is still rendering
above the conversation, or a component's height changes on update (which shifts
every line below it).

### The turn-finalization rewrite — Phase 1's real blocker

Measured in Phase 0, and larger than the prototype doc claimed. When a turn
lands, exactly two lines change, and they are the **first two lines of the
turn's block**, with the whole streamed body appended below them:

    line 169  "── 🔍 Scout ──…"  →  "── 🔍 Scout · 7.3s ──…"   (duration appears)
    line 170  "💭 thinking…"     →  "💭 thought"

So any turn taller than the viewport rewrites above `viewportTop` at the moment
it completes → full redraw → the scrollback it was preserving is cleared.
Measured on the same live room: **120×40 → 1 full redraw** (the first render);
**120×16 → 6**. A 27B model that thinks in 20-line traces clears a 40-row bar
routinely, so this is not an edge case, it is the common case on a laptop.

Both causes are ours and both are fixable in the flatten, not in pi-tui:

- The live header renders at `width - 2` with a streaming cursor, the finalized
  one at `width` with a duration. Make the two identical: render the live header
  at full `width`, move the cursor off the rule, and put the duration on the
  turn's CLOSING line instead of its opening one — the bottom of a block is
  always below the fold, which is precisely why it is safe there.
- `💭 thinking…` → `💭 thought` is a word change on a line that never needed to
  carry state. The state is already visible: the thought is either still growing
  or it is not.

Do this FIRST in Phase 1, before any chrome moves. It is a change to
`transcript-lines.ts`, so it lands in both clients at once and the Ink client
must be re-checked (gate 4 covers the flatten; the header text is asserted).

**Exit:** chrome complete and `fullRedraws === 1` across three consecutive
agent turns on a live room.

**Size:** ~300 lines written, ~300 deleted.

---

## Phase 2 — input: delete `CommandLine`, adopt their `Editor`

**Goal: the single biggest deletion in the migration.**

`CommandLine.tsx` (571) plus `multiline-input.ts` (148), `paste-markers.ts` (61)
and `prompt-history.ts` (66) — 846 lines — are replaced by pi-tui's `Editor`,
which already does multiline, history with draft preservation, kill-ring, undo,
paste markers, grapheme segmentation and autocomplete.

Three things their Editor does **not** have, and which we must not lose:

- **`@mention` routing preview.** Implement `AutocompleteProvider` over the
  roster (their interface: `getSuggestions` / `applyCompletion`), and wire
  `editor.onChange` → `previewRouting()` → the status bar's draft targets.
- **The paste-dispatch guard** (session `mrff3qwe`): pasted text must not be
  able to trigger an agent wave. Their Editor knows about pastes internally;
  the guard must be re-expressed against whatever it exposes. **Unknown — verify
  before committing to this phase**, and if it exposes nothing usable, keep our
  bracketed-paste handling as an input listener in front of it.
- **`!` shell mode.** Simpler now: with no alternate screen there is nothing to
  leave. But the command's output currently lands in the real terminal
  scrollback *below* the app; with an append-only transcript it must be posted
  as a transcript entry instead (the server already records it —
  `POST /api/shell/record`).

The 35 slash commands map onto their `SlashCommand` type
(`name` / `description` / `argumentHint` / `getArgumentCompletions`) and
`CombinedAutocompleteProvider`. `commands/registry.ts` (954 lines) is already
framework-free and does not change — only the palette that drives it.

**Pre-approved client-core exception:** if `previewRouting` needs a signature
change to work from `onChange` instead of Ink state, that is a legitimate
`client-core` diff. Nothing else is.

**Exit:** send, multiline, history, paste markers, `@` routing preview,
slash-command palette, `!` shell — all working on `pmoe-next`. Gates 1–5.

**Size:** ~400 lines written, 846 deleted.

---

## Phase 3 — the generic overlays

**Goal: five overlays become library calls.**

| overlay | lines | becomes |
|---|---|---|
| `SelectOverlay` | 114 | `SelectList` (fuzzy filter built in) |
| `TextInputOverlay` | 95 | `Input` |
| `PresetPickerOverlay` | 143 | `SelectList` + `preset-picker.ts` (unchanged) |
| `TasksOverlay` | 77 | `SelectList` / `Text` |
| `LineupOverlay` | 80 | `Text` |

These are replaced, not ported. Their logic already lives in framework-free
modules (`preset-picker.ts`, `roster-menu.ts`, `seats-menu.ts`,
`answer-picker.ts`), which is why they collapse.

Also here: adopt pi-tui's **overlay stack** (9 anchors, `showOverlay` /
`hideOverlay`, `nonCapturing`). This is what the Ink client fakes.

**Exit:** every command that opens a list works on `pmoe-next`.

**Size:** ~250 lines written, 509 deleted.

---

## Phase 4 — the forms

**Goal: the irreducible cost, done deliberately.**

| overlay | lines | note |
|---|---|---|
| `AgentForm` | 197 | |
| `EditAgentForm` | 206 | shares `preset-composer.ts` |
| `RoomForm` | 326 | the `picking` hack **deletes itself** — it was faking the two-level modal that real overlay stacking provides |
| `PresetComposerOverlay` | 613 | 19 `useState`; the single largest file in the migration |

Do them one per session, in that order — ascending size, and `RoomForm` before
`PresetComposer` so the stacking pattern is established on the smaller case.

For `PresetComposerOverlay`, evaluate pi-tui's `SettingsList` before writing a
custom form; if it fits, this drops from 613 lines to a few dozen. **Unknown —
check first.** Whatever is left of the composer's state machine should move into
`preset-composer.ts` (already framework-free, already tested) rather than being
re-implemented in the new component.

**Exit:** roster editing, room creation, preset composition all work.

**Size:** the bulk. ~1 340 lines rewritten, minus whatever `SettingsList` absorbs.

---

## Phase 5 — the remainder

- `GraphOverlay` (223) — mostly string generation; ports cleanly.
- `PromptOverlay` (135) — pager + `$EDITOR` launch.
- `OAuthPanel` (121) — device-flow UI; blocking, so it wants a captured overlay.
- `answer-picker` / QCM — no more `reservedRows` booking; it is just rows.
- **`/image` finally displays something.** pi-tui ships the kitty and iTerm2
  graphics protocols with reserved-row bookkeeping in the diff. This is a
  feature the migration *adds*, on a kitty terminal with a vision model — worth
  scheduling deliberately rather than discovering.

---

## Phase 6 — flip and delete

1. Default `pmoe` to the pi-tui client; keep the Ink one reachable as
   `pmoe-ink` for one release.
2. Run both for a week of real use. This is a client used daily; the bug that
   matters is the one that shows up on day four.
3. Delete `src/components/`, `src/App.tsx`, `src/cli.tsx`, `useRoomStore.ts`,
   `useTerminalSize.ts`. Drop `ink`, `react`, `@types/react` from dependencies.
4. Rename `src/next/` to `src/`.

**Exit:** one client. `react` and `ink` gone from `packages/tui`.

---

## Order rationale

Chrome (1) before input (2) because the layout inversion is the one thing that
can invalidate the whole approach, and it is cheap to test. Input (2) before
overlays (3, 4) because it is the largest deletion and the daily-driver
experience — a `pmoe-next` you can actually type in gets dogfooded, and a
dogfooded client finds its own bugs. Generic overlays (3) before forms (4) to
establish the stacking pattern on cases that are library calls. The flip (6)
last, obviously, but note that phases 1–5 are individually shippable: at every
point, `pmoe` still works.

## Known unknowns, to resolve before the phase that needs them

- **Paste-dispatch guard** against their Editor's internal paste handling
  (Phase 2). The guard exists because a pasted `@builder` used to dispatch a
  wave; losing it is a real regression, not a cosmetic one.
- **`SettingsList` fit** for `PresetComposerOverlay` (Phase 4). Worth an hour of
  reading before committing to a 613-line rewrite.
- **Resize behaviour** with a long conversation. A width change is a full redraw
  that clears the scrollback — unavoidable in this architecture (claude_code
  pays it too), but confirm it is not worse than that. Phase 0 saw a height
  change alone also trigger one (`height=16` → `height=40` in the redraw log),
  which is expected but worth knowing before blaming a component for it.
- **tmux + `PI_HARDWARE_CURSOR`.** The prototype ran with the hardware cursor
  on; verify it behaves under tmux, which is where it usually goes wrong.

## What this plan deliberately does not do

Rewrite `client-core`, touch the server, change the protocol, or "improve"
anything while migrating. Every phase is a translation with a measurable
before/after. Feature work resumes after Phase 6 — the whole point of the gates
is that the client's behaviour is a constant while its renderer changes
underneath.
