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
      proto/          deleted at the end of Phase 0 (absorbed into src/next/)

## The gates

Every phase ends by re-running these. They are what make each step reversible
and each regression visible. A phase is not done until all five hold.

1. **`fullRedraws === 1`** through a complete streaming turn, measured with
   `--stats` on a live room. Any increase means a line above the viewport was
   rewritten, which means the terminal scrollback was cleared — the entire
   reason for the migration, silently lost.
2. **No history rewrite.** `proto/probe-stability.ts` (moving to
   `src/next/dev/`) reports the first differing line index per state change.
   Nothing may change below `lines.length - terminalRows` except the two known
   turn-finalization rewrites (header rule gains its duration, `💭 thinking…`
   becomes `💭 thought`).
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

---

## Phase 0 — foundation

**Goal: one transcript renderer, two clients, and a declared dependency.**

- Declare `@earendil-works/pi-tui` in `packages/tui`'s dependencies. Today the
  prototype only works because npm hoists it out of `pi-coding-agent`.
- **Extract, don't copy.** `proto/lines.ts` is currently a copy of
  `Transcript.tsx`'s flatten. Promote it to `src/transcript-lines.ts`
  (framework-free) and make `Transcript.tsx` call it. The Ink client keeps its
  windowing (`offset`, `bodyHeight`) and slices the returned array; the pi-tui
  client returns it whole. One renderer, two consumers — and the copy that would
  otherwise drift disappears immediately.
- Add `src/next/` with the prototype's `main.ts` as its entry, plus the
  `pmoe-next` bin. Move `probe-stability.ts` and `bench.ts` to `src/next/dev/`.
- Add a `transcript-lines.test.ts` covering the flatten directly. It currently
  has none — `Transcript.tsx` was never unit-testable, which is exactly the
  problem the extraction fixes.

**Exit:** `pmoe` and `pmoe-next` both run against the same room and render an
identical transcript. Gates 1–5.

**Size:** small. The code exists; this is mostly moving it and deleting a copy.

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
  pays it too), but confirm it is not worse than that.
- **tmux + `PI_HARDWARE_CURSOR`.** The prototype ran with the hardware cursor
  on; verify it behaves under tmux, which is where it usually goes wrong.

## What this plan deliberately does not do

Rewrite `client-core`, touch the server, change the protocol, or "improve"
anything while migrating. Every phase is a translation with a measurable
before/after. Feature work resumes after Phase 6 — the whole point of the gates
is that the client's behaviour is a constant while its renderer changes
underneath.
