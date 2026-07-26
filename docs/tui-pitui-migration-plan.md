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
   test, the step is wrong — *unless the step is a behaviour fix this plan names*,
   in which case the test moves with it and the phase notes why (dax, 2026-07-26:
   *"oui tu peux modifier un test, c'est cohérent qu'il faudra faire des
   modifications sur les tests pour faire fonctionner la nouvelle stack"*). The
   line to hold is that a test never changes to accommodate a RENDERER swap.
   Phase 1 changed two, both named here; Phase 2 changed none.
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

## Phase 1 — chrome, below the conversation ✅ DONE (2026-07-26)

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

**Exit — met.** All six live in `src/chrome-lines.ts` (~200 lines), a pure
function of state producing painted lines, plus a ~40-line `ChromeComponent`.
`fullRedraws === 1` across turns on a live room at 120×40 AND at 120×16, the
short screen that used to cost 6; 309 lines of native scrollback retained. The
status bar's per-second tick is included and costs nothing above the fold.

**Two things this phase found that were not in the plan:**

- **Chrome height now has a streaming cost.** pi-tui writes the contiguous range
  `firstChanged..lastChanged`, so whenever the transcript's line count shifts,
  every chrome line below it is rewritten. Measured: 99 B/token with no chrome,
  805 with the real eight lines, ~39 B/token per additional line. The migration
  still wins ~5× over Ink at the same terminal instead of 39×, and the answer is
  to keep the chrome compact — not to move it back up, where it costs the
  scrollback instead of bytes.
- **The two width measures disagree.** `▶` (U+25B6) is East Asian Ambiguous:
  `string-width` calls it 2 columns, pi-tui's measure calls it 1. A status bar
  pi-tui believed fitted was one column too wide by the other measure, and if the
  terminal sides with string-width the row soft-wraps and every chrome line below
  it shifts — silently corrupting pi-tui's accounting for the session.
  `chrome-lines.ts:fit()` now satisfies the stricter of the two. Any future
  component using ambiguous-width glyphs inherits the same trap.

**Deliberate duplication:** the Ink client keeps its own six JSX components,
frozen, until Phase 6. Rewriting a working client's chrome to consume line arrays
would be churn on code scheduled for deletion. This is the OPPOSITE call from the
transcript, which was extracted precisely because it must survive the migration.

**Size:** ~200 lines written (chrome-lines) + ~40 (component) + 21 tests; nothing
deleted yet — the Ink components die in Phase 6.

---

## Phase 2 — input: delete `CommandLine`, adopt their `Editor` ✅ DONE (2026-07-26)

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
  able to trigger an agent wave. **Resolved — their Editor exposes exactly what
  the guard needs, and closes the other half itself.** The guard rests on one
  property: the routing preview and the send must agree on which string routes.
  `editor.getExpandedText()` provides it (a marker hides `@mentions`; the preview
  must show what send will dispatch), and `onChange` fires it per keystroke. The
  structural half is theirs: `ProcessTerminal` enables bracketed paste and the
  Editor buffers until the end marker (`components/editor.js:498`), so a newline
  inside a paste can no longer be read as ⏎ — the hazard our own accumulator
  existed to prevent. Their `handlePaste` is also more careful than ours: it
  decodes the CSI-u re-encoding tmux popups apply to control bytes inside a
  paste. Verified live: a 7-line report quoting `@builder` and `@tester` pasted
  without dispatching, and the status bar read `⏎⇒ @builder @tester` before ⏎.
- **`!` shell mode.** This plan said: with no alternate screen there is nothing
  to leave, so post the output as a transcript entry instead. Half right. There
  IS something to protect — the scrollback the whole migration exists for — but
  the local interactive run did not have to be given up to protect it, and giving
  it up would have cost `sudo`, `ssh` and anything else that prompts. Both are
  kept: the command runs locally with the terminal handed over, its output stays
  in native scrollback, and the capture is still offered to the room
  (`POST /api/shell/record`) rather than posted silently. See the resume finding
  below for how coming back works.

The 35 slash commands map onto their `SlashCommand` type
(`name` / `description` / `argumentHint` / `getArgumentCompletions`) and
`CombinedAutocompleteProvider`. `commands/registry.ts` (954 lines) is already
framework-free and does not change — only the palette that drives it.

**Pre-approved client-core exception:** if `previewRouting` needs a signature
change to work from `onChange` instead of Ink state, that is a legitimate
`client-core` diff. Nothing else is.

**Exit — met.** All verified live on the scratch instance: send, Alt+⏎ multiline,
↑ history, paste markers, the `@` routing preview, the slash palette (Tab
completes, ⏎ runs the highlighted command, `/route semi` reached the server and
came back in the status bar), `!` shell in both its local and shared forms, ⇧⇥
routing cycle, and Esc arbitrated three ways. 1 full redraw across a 6-message
multi-agent wave, 837 frames, 1 MiB written. No crash at 60 columns.

Written: `next/autocomplete.ts` (the palette + `@` completion as a pure function
of the draft), `next/submit.ts` (what ⏎ means), `next/commands.ts` (the registry's
`CommandContext`, built from pi-tui pieces), `next/shell.ts`, `pty-capture.ts`
(extracted from `App.tsx`, now shared and finally tested), plus the wiring — ~570
lines, 44 tests. Nothing deleted yet: `CommandLine.tsx` and its three companions
(846 lines) still serve the shipping Ink client and die in Phase 6 with the rest
of `src/components/`.

**Three things this phase found:**

- **Their Editor resets itself BEFORE calling `onSubmit`, and hands you the text
  as the argument** (`submitValue()`: state, paste store and undo stack cleared,
  then `onSubmit(result)`). That is the opposite contract from our
  `CommandLine`, which read its own state at submit time — and reading the editor
  back inside the handler is silently EMPTY rather than an error. It cost every
  slash command a no-op, invisible in a typecheck and in every unit test, caught
  only by typing `/zzz` into a live client and seeing no notice.
  It also decides what history stores: Ink kept the line as typed, markers
  included, because its paste store outlived the send. Theirs does not, so a
  marker in history could never expand again — history gets the expanded text.
- **`clearOnShrink` is OFF by default, and the type declaration says the
  opposite.** `tui.d.ts` documents "when true (default)"; `tui.js:127` reads
  `process.env.PI_CLEAR_ON_SHRINK === "1"`. This matters more than a doc typo:
  with it ON, every disappearing notice — content one line shorter than the
  high-water mark — costs a full redraw WITH the scrollback clear. Phase 1's
  freely-changing chrome height is only free because of this default. Anything
  that sets that env var, or a future `setClearOnShrink(true)` for an overlay,
  pays for it everywhere.
- **`!` shell resumes *below* the output instead of clearing.** `requestRender(true)`
  is the wrong tool: it invalidates the width and height, which routes into
  `fullRender(clear)` — screen and scrollback — erasing both the command output
  and the conversation. Forgetting only the previous frame and keeping the
  dimensions makes pi-tui take its "first render, assumes clean screen" branch and
  re-print the app under the shell output, with everything above preserved.
  Verified: `history_size` 16 → 74, `$ echo hello-from-shell` and its output still
  selectable in the terminal's own history. There is no public API for it
  (`tui.js:1060` is the branch), so `next/shell.ts` reaches the private field with
  a guarded fallback. This is better than the Ink behaviour, where local output
  landed in a different screen buffer from the app.

**On the gate-1 counter:** a `!` run increments `fullRedraws`, and that increment
is not a failure. pi-tui counts clearing and non-clearing full renders together;
the shell resume is deliberately the non-clearing kind. Read the counter with
`PI_DEBUG_REDRAW=1`'s log beside it — `first render` entries are free, everything
else is not.

**Size:** ~570 lines written and 44 tests; 846 lines booked for deletion in Phase 6.

---

## Phase 3 — the generic overlays ✅ DONE (2026-07-26)

**Goal: five overlays become library calls.**

| overlay | lines | becomes |
|---|---|---|
| `SelectOverlay` | 114 | `SelectList` + `fuzzyFilter` |
| `TextInputOverlay` | 95 | `Input` (masking stays ours) |
| `PresetPickerOverlay` | 143 | `overlay-frame` + `preset-picker.ts` (unchanged) |
| `TasksOverlay` | 77 | `overlay-frame` |
| `LineupOverlay` | 80 | `overlay-frame` |

These are replaced, not ported. Their logic already lives in framework-free
modules (`preset-picker.ts`, `roster-menu.ts`, `seats-menu.ts`,
`answer-picker.ts`), which is why they collapse.

Also here: adopt pi-tui's **overlay stack** (9 anchors, `showOverlay` /
`hideOverlay`, `nonCapturing`). This is what the Ink client fakes.

**Exit — met.** All five work on `pmoe-next`, verified live: `/help` (35 commands,
fuzzy filter, `(1/35)` counter), `/providers` chaining into a masked key prompt,
`/roster` → submenu → Esc reopening its parent, `/lineup` pausing and reordering
agents through real store actions, `/preset` with its live preview, and ⌃P
toggling the task board both ways. One full redraw across the whole session —
five overlays opened and closed, one of them raised DURING a streaming turn, and
the transcript restored with no ghost. Every redraw after the first was a terminal
width change, the one unavoidable case.

Written: `next/overlay-frame.ts` (the box, pure — 90 lines), `next/overlays.ts`
(the five components — 370), `next/overlay-host.ts` (the registry bridge — 150),
plus 55 tests. The 509 Ink lines are booked for Phase 6 with the rest of
`src/components/`.

**Four things this phase found:**

- **`SelectList.setFilter` is not what the table above promised.** It is a
  case-insensitive PREFIX match on `item.value` (select-list.js:25) — which for us
  is the opaque id, so it would match neither the label nor the hint. The fuzzy
  filter is real but lives in `fuzzy.ts` as `fuzzyFilter`, and it takes any text
  extractor. What it buys over our `includes()` is the ORDER: a one-character
  query matches half the list, and the best match is the one ⏎ picks.
- **`SelectList` fixes its items AND its window height at construction.** No
  setters. So a new filter or a resize means a new list — cheap (it holds two
  arrays) and it resets the cursor to the top, which is what our Ink version did
  on every filter change anyway.
- **`maxHeight` TRUNCATES, it does not shrink.** Handing pi-tui a tall overlay and
  a `maxHeight` cuts the bottom rows off — the key legend, which is exactly the
  row a cramped screen needs most. So a windowed list has to compute its own row
  budget from the terminal height, which `render(width)` does not provide.
  Verified on a 14-row screen: the roster list windows to 3 rows, keeps its
  `(1/7)` counter and keeps its legend.
- **Registry overlays must REPLACE, not stack, and that is the faithful
  translation.** `commands/registry.ts` was written for a single-modal client and
  compensates with `onCancel` callbacks that reopen the parent by hand (/model is a
  loop of pickers built that way). If `openOverlay` pushed, Esc would pop back to
  the parent AND `onCancel` would reopen it — two parents, one a ghost. The stack
  is adopted and available; Phase 4 is where a form raising a picker finally needs
  it.

**One deliberate visible loss:** `SelectList` prints an `(n/total)` counter where
our Ink overlay printed `▲ more` / `▼ more` markers and pushed each hint to the
right edge. Taking the library's layout gives up the markers and the ragged right
edge on list pickers; the three overlays that are not list pickers keep theirs,
because there is no library component to defer to. Masking also costs the cursor:
`Input` renders its own value and keeps its cursor private, so a masked field
shows bullets with no cursor. Acceptable — the field exists to paste a key and
check its last four characters.

**Size:** ~610 lines written and 55 tests; 509 booked for deletion in Phase 6.

---

## Phase 4 — the forms ✅ DONE (2026-07-26)

**Goal: the irreducible cost, done deliberately.**

| overlay | lines | note |
|---|---|---|
| `AgentForm` | 197 | |
| `EditAgentForm` | 206 | shares `preset-composer.ts` |
| `RoomForm` | 326 | the `picking` hack **deletes itself** — it was faking the two-level modal that real overlay stacking provides |
| `PresetComposerOverlay` | 613 | 19 `useState`; the single largest file in the migration |

**Exit met.** All four are live on `pmoe-next` and the registry dispatches them
unchanged. Verified end to end against a scratch server: an agent created with a
hand-toggled tool grant (server confirms `bash` added), an agent's name and colour
PATCHed, a room created from a picked preset with a goal that auto-started it, and
a preset remixed → member card → model catalogue filtered to `grm` → committed →
renamed → saved, with `local/GRM 2.6` pinned in the document on disk.

**`SettingsList` does NOT fit — the named unknown, answered.** It is a
label→value list where ⏎ cycles a fixed `values` array or opens a submenu that
*replaces* the list's render. Four things our forms need are not in it: text
edited **in place** (nine of the member card's fourteen rows are free text, and
routing each through a submenu turns "type a name" into a modal dive); a **submit
action** with validation that runs once and an error that stays next to the field;
**multi-select** (`tools` is seventeen checkboxes with a horizontal cursor, not a
one-at-a-time cycle); and **interleaved non-rows** (the room form prints a live
persona preview *between* its fields).

**What shrinks 1 340 lines is not a library component — it is not writing the
keyboard loop four times.** The four Ink forms were four copies of the same loop
(↑↓ between rows, type to edit, ←→ to cycle, space to toggle, ⏎ to advance or
submit, esc to cancel), and `MemberEditor` had already half-extracted it into a
local `Row` union. Finished and made framework-free, that union is
`src/next/form.ts` (~330 lines): five row kinds (`text`, `cycle`, `chips`, `note`,
`action`), windowing, chip wrapping, the error line and the contextual legend. The
four forms are then declarations — `src/next/forms.ts` for the three wizards
(~330 lines for all three) and `src/next/composer.ts` for the roster screen plus
the member card (~430).

**The engine does two things the Ink forms could not.** It **windows**: pi-tui's
`maxHeight` truncates rather than shrinks (the Phase 3 finding), so on a short
screen `[ Create ]` and the key legend were the first things off the bottom —
rows are now windowed around the focused one with `▲/▼ more` markers, verified on
a 14-row screen where the Create row stays reachable and the legend survives. And
it **wraps its own chips**, explicitly and measurably, instead of handing that to
Yoga's `flexWrap` (which is also where nested `<Text>` runs came back with
fragmented widths — the lesson in `CommandLine.tsx`).

**The `picking` hack is deleted, not ported.** `open()` keeps replacing for the
registry; forms get `push()`. The room form's Preset row raises the roster picker
*on top of itself* and the typed name is still there behind it. The composer goes
three deep — roster → member card → model picker — and pi-tui hands focus back one
layer at a time on each hide. That also removes the composer's three
`isActive && !thatOtherThing` conjunctions.

**One correction to Phase 1, found live.** `overlay-frame.ts` was measuring width
two different ways at once, and both were wrong. `▶` is East Asian Ambiguous:
`string-width` says 2 columns, pi-tui and the terminal say 1. Padding used
string-width, so a focused form row — the only line in the app carrying a `▶` —
came out one column short of its own border (measured at 120 columns: every framed
line 108 wide except the focused one, at 107). Fitting used the *stricter* of the
two, which cropped a line that exactly filled the box (`@scout` → `@s…`). There is
one ruler now, pi-tui's, because that is what its compositor, its line-length
check and the terminal all use. **The gate-3 tests did not catch either half
because they measured with the same overcounting ruler as the code** — they use
`visibleWidth` now.

**Two smaller findings.** `ALL_TOOLS` lived in the Ink `AgentForm.tsx` while
`preset-composer.ts` separately kept the same list as `TOOL_GROUPS`; it moved to
the framework-free module and the Ink component re-exports it, so there is one
copy of the server's allowlist. And the member card's legend said "esc cancel"
next to a key that *commits* — the engine now takes a `cancelHint`, because a
legend that lies about a destructive-looking key is worse than no legend.

**Size:** ~1 090 lines written (engine + three wizards + composer) and 76 tests,
against 1 342 booked for deletion in Phase 6.

---

## Phase 5 — the remainder ✅ DONE (2026-07-27)

**Goal: parity. After this phase there is nothing `pmoe` does that `pmoe-next`
cannot, which is the precondition for flipping the default.**

| piece | lines | landed as |
|---|---|---|
| `GraphOverlay` | 223 | `next/graph.ts` (~200) |
| `PromptOverlay` | 135 | `next/prompt.ts` (~165) + `external-editor.ts`, shared with Ink |
| `OAuthPanel` | 121 | `next/oauth.ts` (~135) |
| `answer-picker` / QCM | — | `next/answers.ts` (~120); `pickerRows` is now called by the Ink client only |
| room switching + tab strip | — | `next/rooms.ts` + the store rebinding in `main.ts` |
| **inline images** | — | `next/images.ts` (~150) — the feature the migration ADDS |

**Exit met.** All eleven overlay kinds are served; `commands.ts` no longer posts a
"lands in phase N" notice for anything. Verified live against a scratch server on
:5399, at 120 and 56 columns: the graph on a real three-hop turn (`you → Planner →
Builder → Planner`, route/handoff tinted) and its flows ledger; the prompt pager
wrapping a 44-line system prompt, `e` into real vim, `ggIEDITED-BY-VIM`, `:wq`, and
the server confirming the new prompt; a planner `ask_user` with three closed
options answered by pressing `3`; `/image` posting a real 830 KB PNG (server saved
`media/bf99d031a49e.png`); ⌃V staging a PNG off the Wayland clipboard and sending
it with text (server: both messages carry the image); ←→ across `[main-room,
Second Room, + room]` with the highlight following and `⏎` on `+` opening the
create/resume entry; and `/rooms` switching with its notice surviving the store
swap.

**The graph was the cheapest port in the migration, for a reason worth naming.**
`deriveHandoffGraph` and `deriveHandoffChain` already live in client-core — the web
graph reads the same two functions — so `GraphOverlay.tsx` was 223 lines of
*padding and colour* around two pure derivations. Remove the JSX and what is left
is string generation. The one behavioural fix: switching view resets the scroll
(the Ink version shared one offset between two lists of different lengths, which
landed you mid-list in a list you had not scrolled).

**`$EDITOR` does not have to cost the scrollback.** The obvious resume is
`requestRender(true)`, and it is wrong: that invalidates the dimensions, and pi-tui
answers a dimension change with `\x1b[2J\x1b[H\x1b[3J` — screen *and* scrollback,
i.e. the conversation. `!` shell mode had already solved this in Phase 2
(`resumeBelow`: forget the previous frame, keep the dimensions, let pi-tui take its
"first render — assumes clean screen" path and re-print below whatever the child
left). "Someone else drew on this terminal" is one problem with one answer, so
`resumeBelow` is exported and `/prompt` uses it. Measured: `fullRedraws` 1 → 2, log
line `fullRender: first render (prev=0, new=46)`, and the turn from before the edit
still on screen afterwards — that branch calls `fullRender(false)`, so the counter
moves and nothing is erased.

**The QCM picker is the migration's argument in miniature.** Same decisions
(`answer-picker.ts`, untouched, called by both clients); what disappears is
`pickerRows(n) = n + 4`, a number that existed only because the Ink Transcript's
height math assumed a fixed-size command line — and which the App had to keep
booked *even while the picker was hidden by typing*, because a layout that jumps is
worse than one that wastes four rows. Here it is a component that returns rows when
it has something to say and `[]` when it does not.

**Images: what pi-tui gives, and what it refuses.** An attachment line carries its
paths (`Line.images`, additive — Ink renders the same `📎 N images` text and
ignores the field), and the pi-tui transcript swaps in kitty/iTerm2 rows: one line
holding the escape sequence, `rows - 1` blank lines after it, which is the shape
pi-tui's diff understands (`getKittyImageReservedRows`,
`expandChangedRangeForKittyImages`). Three things had to be right. Image lines must
bypass the transcript's `" " + truncateToWidth(...)` — a prefix inside a graphics
sequence corrupts the payload, and pi-tui exempts them from the width throw for the
same reason. The `Image` instances are cached, so the same *string reference* comes
back every frame and the differ compares a megabyte of base64 in O(1) instead of
re-encoding it per token. And images are capped at 16 rows, because a block that
does not fit the viewport makes pi-tui fall back to a full render ("kitty image
pre-clear would scroll") — one that fits costs nothing.

**pi-tui refuses image protocols under tmux, deliberately** (`detectCapabilities`:
`if (process.env.TMUX) return { images: null, … }`), so the client keeps its `📎`
line there — verified, and it is why the drawn image could not be photographed
through `tmux capture-pane`. What was verified instead: the real bytes, fetched
from the live server through the real code path, produce
`ESC_Ga=T,f=100,q=2,C=1,c=48,r=8,i=…` followed by exactly seven blank rows. The
sequence is correct and the placement is library code.

**Room switching rebinds the store, and nothing captures it.** A store is bound to
one room at construction, so a switch builds a new one and disposes the old —
hydrate-then-swap (preload, then swap, so nothing flashes empty) with a monotonic
token so a stale preload cannot yank the user back. Everything therefore reads
`getState()` / `currentStore()` at call time: `commands.ts`, `shell.ts` and
`OverlayHost` all took a `() => RoomStore` this phase. A switch also closes the
overlay stack — a line-up editor holding the previous roster would apply its next
keystroke to a room the user has left.

**Both known unknowns resolved, live.**

- **Resize with a long conversation** costs exactly one full redraw per width
  change (`fullRender: terminal width changed (120 -> 56)`), and it is *not* worse
  than the plan feared: because the transcript returns the whole conversation every
  frame, the clear is immediately followed by a full re-print — after resizing
  twice, the scrollback still began at the first `── You ──` and contained exactly
  one status bar (no ghost frames). Bounded only by the terminal's own scrollback
  limit.
- **tmux + `PI_HARDWARE_CURSOR`** behaves. With `showHardwareCursor: true` under
  tmux, typing `hello cursor` put the pane cursor at `12,35` with the input line at
  screen row 35 — the insertion point, exactly.

**What a full redraw actually costs, since Phase 5 adds three ways to spend one.**
Through a streaming turn the counter stays put — a fresh turn late in the session
added zero. Deliberate whole-screen events each cost exactly one: `$EDITOR` resume
(no clear), a width change (clear + full re-print), and a room switch
(`firstChanged < viewportTop (0 < 73)` — the whole transcript changes, including
lines that scrolled away, so the clear is correct rather than a regression).

**Not verified live: the OAuth flow itself.** Starting one means contacting an
external provider and opening a browser tab, which this project's rules put out of
bounds (`CLAUDE.md`: local only). The panel's six statuses, its input line and its
key handling are covered by tests; its mounting is `pushComponent`, the same path
the member card proved live in Phase 4. Two things it gained: pi-tui's `hyperlink()`
replaces a hand-copied OSC 8 sequence in *both* clients, and its `Input` replaces a
field that displayed `"…" + value.slice(-59)` — a redirect URL is exactly the string
whose interesting end you need to see whole.

**⌃V was a parity gap, and it is closed here.** An image on the clipboard stages
rather than sends (the web Composer's contract), and because this client can draw,
the staged image is shown *as the image* — the one place where "did I paste the
right screenshot?" has an answer before you press ⏎.

**Size:** ~770 lines written and 70 tests (repo: 1 775 green), against 479 booked
for deletion in Phase 6.

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

- ~~**Paste-dispatch guard** against their Editor's internal paste handling
  (Phase 2).~~ **Resolved 2026-07-26** — `getExpandedText()` + `onChange` carry
  our half, their bracketed-paste buffering carries the structural half. See
  Phase 2.
- ~~**`SettingsList` fit** for `PresetComposerOverlay` (Phase 4).~~ **Resolved
  2026-07-26 — it does not fit**, for four concrete reasons (no in-place text, no
  submit action, no multi-select, no interleaved rows). The saving came from
  writing the keyboard loop once instead of four times. See Phase 4.
- ~~**Resize behaviour** with a long conversation.~~ **Resolved 2026-07-27 — one
  full redraw per width change, and the conversation is re-printed rather than
  lost** (the transcript returns every line each frame). Phase 0 saw a height
  change alone also trigger one, which is expected but worth knowing before
  blaming a component for it. See Phase 5.
- ~~**tmux + `PI_HARDWARE_CURSOR`.**~~ **Resolved 2026-07-27 — it behaves**: the
  pane cursor sat exactly at the insertion point under tmux. See Phase 5.

## What this plan deliberately does not do

Rewrite `client-core`, touch the server, change the protocol, or "improve"
anything while migrating. Every phase is a translation with a measurable
before/after. Feature work resumes after Phase 6 — the whole point of the gates
is that the client's behaviour is a constant while its renderer changes
underneath.
