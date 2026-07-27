# TUI: what the pi-tui client makes possible

The migration plan's standing rule was *a phase is a translation, not an
improvement* — five gates, measurable before/after, behaviour held constant
while the renderer changed underneath. That rule was right, and it means five
phases' worth of "we could now do X" was noticed and not written down anywhere
except in passing.

This is that ledger. It is not a roadmap and nothing here is scheduled: the
gates still hold, so **nothing in this document lands before Phase 6 flips the
default and the Ink client is gone.** Until then, any entry that touches a
shared module (`transcript-lines.ts`, `chrome-lines.ts`, `roster-strip.ts`,
`markdown.ts`) would change the shipping client, which is exactly what the
migration forbade.

Each entry says what changed structurally to make it possible, what it costs,
and — the part that matters — whether the number in it was **measured** or
**estimated**. Phase 4's `SettingsList` evaluation is the model: the honest
outcome of an evaluation is sometimes "it does not fit", and that outcome is
worth as much as the adoption.

---

## 0. The one that is not an improvement — it is a bill

**Per-frame transcript cost is now O(conversation), and it used to be
O(viewport).**

This is first because it is the only entry that is a regression rather than an
opportunity, and because it is the direct price of the thing the migration was
for.

The Ink client windowed the transcript: it clipped to `bodyHeight` and rendered
that. Clipping was a correctness workaround (past screen height, Ink's row
diffing corrupted), but it was *also*, accidentally, a performance bound — no
matter how long the conversation, the frame built one screenful of lines.

`pmoe-next` has no scroll state by design. The transcript component returns
**every line of the conversation every frame** and lets pi-tui diff the array.
That is what buys native scrollback, and the diff itself is cheap. What is not
cheap is *building* the array, and the build happens once per store change —
i.e. per streaming token.

**Measured** (2026-07-27, this machine, warm markdown cache, 120 columns, a
synthetic conversation of markdown-heavy assistant turns):

| conversation | rendered rows | per-frame build |
|---|---|---|
| 20 messages | 160 | 1.4 ms |
| 100 messages | 800 | 6.6 ms |
| 200 messages | 1 600 | 12.1 ms |
| 600 messages | 4 800 | 37.9 ms |

Linear, as expected — and 38 ms per token is a whole core at 26 tok/s, on a
client whose selling point is that it does not repaint. Note the markdown cache
is already warm in those numbers: this is pure `Line` construction, `paint`,
and `truncateToWidth` over the whole history.

**The fix is a mechanism this codebase already ships.** `images.ts` caches
`Image` instances so the same *string reference* comes back each frame, which is
why a megabyte of base64 costs the differ O(1) instead of being re-encoded per
token (Phase 5 finding). The same idea applies to every finalized message: a
message that will never change again should hand back the identical string array
it handed back last frame, keyed on `(text, width)`. Only the live tail — the
streaming message, the live reasoning, the live parts — needs rebuilding.

**Measured floor:** concatenating 4 800 already-built line references costs
**0.033 ms**. So the ceiling on this optimization is roughly three orders of
magnitude, and the realistic target is "the streaming tail, plus a concat".

Two things to get right, and both are why this is not a five-minute change:

- **Reference stability must be exact.** Returning an equal-but-new string
  defeats the entire point silently — the frame still renders correctly, it just
  stays slow. Any test for this has to assert `toBe`, not `toEqual`.
- **The cache key includes the width**, and a resize must not throw the whole
  thing away. See entry 4.

Gate 1 does not catch this and never would: the count of full redraws is
unchanged. It is a CPU cost inside a correct frame. If a durable check is
wanted, it is a bench, not a gate.

---

## 1. pi-tui's `Markdown` component — evaluate, do not assume

We render markdown through `marked` + `marked-terminal` + `wrap-ansi`
(`src/markdown.ts`, with a `text`-renderer override because marked-terminal
leaks raw source out of tight list items, and a post-wrap pass because it only
reflows paragraphs). pi-tui ships a `Markdown` component with a themable
renderer, an optional `highlightCode` hook, and its own render caching.

What makes this newly worth asking: `markdown.ts` is currently shared by both
clients, so it was untouchable for five phases. After Phase 6 it has one caller.

Adopting it would take three direct dependencies out of `packages/tui`
(`marked`, `marked-terminal`, `wrap-ansi` — the last is used *only* by
`markdown.ts`, verified) and delete the two workarounds above. It would also put
markdown rendering on the same width ruler as everything else, which is the
invariant Phase 4 established.

**But do not assume it fits.** Things to check against the real transcript
before committing, in this order, because the first two are the ones that would
kill it:

1. **Tables.** marked-terminal renders them; agents emit them. Does pi-tui's?
2. **The width contract.** Ours takes a width and returns final display lines
   that slot into a line array. pi-tui's takes `paddingX`/`paddingY` and is a
   `Component`. A component that owns its own wrapping is a different shape from
   a function that returns lines — the transcript needs lines.
3. Code-fence highlighting parity, including the *unclosed* fence: our comment
   documents that CommonMark runs an open fence to end-of-input, which is why
   code starts highlighting the moment the fence opens while streaming.
4. Whether its cache is keyed such that the streaming case (an ever-growing
   prefix, re-parsed every tick) does not churn it — the exact reason our two
   caches are separate.

Estimated, not measured. The plausible outcome is partial adoption: its
renderer, our wrapper.

---

## 2. `Loader` / `CancellableLoader`

pi-tui ships an animated spinner bound to the TUI's render loop, and a
cancellable variant that handles Escape itself and exposes an `AbortSignal`.

`CancellableLoader`'s shape is *exactly* the shape of a pipeline-moe turn: work
is running, Escape means abort, and the abort has to reach an in-flight request.
Today that lives in the status bar's own animation plus an Escape branch in the
input listener that falls through to `/abort`.

Newly possible because the client is now a component tree with a real focus
model (Phase 3/4), so a loader can take focus for the duration of a blocking
operation instead of the whole input listener having to know about it. The
candidates are the operations that currently just freeze with no feedback:
`preloadRoomState` during a room switch, `resumableRooms()` before the picker,
and `getParticipant` behind `/prompt`'s "Loading…".

Small, isolated, and it removes hand-rolled animation state. Estimated: an
afternoon.

---

## 3. The keybinding registry — backlog item 5, finally reachable

`main.ts` already calls `setKeybindings` with pi-tui's defaults, but every
pipeline-moe binding (⌃P, ⌃R, ⌃O, ⌃T, ⇧⇥, ⌃V, the arrow-key tab navigation, the
`+` handling) is a hardcoded branch in one input listener, ordered by hand — and
the order is load-bearing, which is the smell. `KeybindingsManager` is
declarative and ships conflict detection.

What Phase 5 exposed: the listener now has an overlay branch, the answer
picker's claim (`handleKey` returning true *before* the editor sees the byte),
six chords, and a three-way Escape (staged images → draft → `/abort`). That
chain is correct and it is also the place where the next binding will introduce
a bug that only shows up when two features are active at once.

The real prize is not remappability for its own sake — it is that *claiming* a
key becomes explicit and conflicts become a startup error instead of a
mystery. User-remappable bindings via config fall out for free.

The migration deliberately did not do this: a declarative rewrite of the input
layer is not a translation, and doing it mid-phase would have made gate
failures un-attributable.

---

## 4. Resize is cheaper than it looks, and the caches could make it free

**Measured, Phase 5:** one full redraw per width change, and the conversation is
re-printed rather than lost. Fine.

What is *not* free: `markdown.ts` drops both caches wholesale when the width
changes (`cacheWidth`), so a 120 → 56 → 120 round trip re-parses the entire
conversation twice. Combine with entry 0's numbers and a couple of window drags
is the most expensive thing this client does.

Keying the caches by `(text, width)` with a bounded per-width map instead of a
single width plus a clear would make the return trip free. This is a
smaller change than entry 0 and shares its key, so they should be done together
or the second one will re-litigate the first.

---

## 5. Images, past `/image`

The strip exists, it works, and it is currently reached by exactly two paths:
an attachment line in the transcript, and the ⌃V staging preview. Everything
below is now a matter of *pointing something at it*:

- **Agent-produced images.** A tool that returns a screenshot or a plot writes
  it to `media/`; the transcript already draws an attachment line for it. Worth
  checking end to end, because "the strip works" was verified with a
  user-supplied PNG, not a tool-produced one.
- **The 16-row cap could be viewport-aware.** It is a constant because a block
  that does not fit the viewport forces `fullRender(true)` every frame ("kitty
  image pre-clear would scroll"). The real constraint is the viewport, not 16.
  Making it `min(16, rows - chrome)` costs nothing and shows more image on a
  tall terminal.
- **Cleanup.** pi-tui exports `deleteKittyImage` / `deleteAllKittyImages`. We
  never call either. Whether that matters depends on whether image ids
  accumulate across a long session — **unmeasured, and worth measuring before
  assuming either way.**

Standing constraint, not a bug: **pi-tui refuses graphics protocols under tmux
on purpose** (`detectCapabilities`). Anything in this section is unverifiable
through `capture-pane` and needs a bare kitty.

---

## 6. Overlays: nine anchors, and we use one shape

Phase 3 adopted the overlay system and Phase 4 used its stacking to delete
`RoomForm.tsx`'s `picking` hack. But every overlay we push is still the same
thing: a centred, capturing, full-width-ish box.

The two features left on the table:

- **`nonCapturing` overlays** for anything that should appear without taking the
  keyboard. Notices are currently chrome lines, which means they occupy layout
  and push everything up; a corner toast would not.
- **Anchors other than centre**, which is what makes the above readable.

This is the one entry that is a genuine UI change rather than a structural one,
so it is also the one that most needs to wait for the week of real use in Phase
6 — the current notices are not obviously wrong, and "we have nine anchors"
is not a reason to use them.

---

## 7. An open question worth settling with a measurement

`chrome-lines.ts` fits every line with a loop that satisfies **both** width
measures — pi-tui's `visibleWidth` and `string-width` — because they disagree
about `▶` (U+25B6, East Asian Ambiguous: 1 column vs 2), our status bar and task
line both use it, and nobody here knows which measure a given terminal follows.
The loop converges in a step or two over ~7 lines, so the cost is nothing; the
*complexity* is the loop plus a dependency (`string-width`, also used by
`roster-strip.ts`).

Note this is **not** unlocked by Phase 6 — the uncertainty is about terminals,
not about Ink. What would settle it is an actual measurement: print `▶` in
kitty, foot, and tmux, and read back the cursor column. If they all agree with
pi-tui, the loop and the dependency go; if any one of them does not, the loop is
correct and should get a comment saying so with the evidence.

Cheap, and it converts a defensive workaround into a known fact either way.

---

## Order, if someone asks

**0 and 4 together** — they share a cache key, they are the only entries with
measured numbers behind them, and 0 is a real bill that grows with every day of
use. Then **2** (small, self-contained, removes state). Then **7** (an
afternoon's measurement that either simplifies or documents). Then **1** as a
proper evaluation with a written verdict. **3** wants a quiet week. **5** and
**6** after real use has said whether they matter.

## How to keep this honest

Every entry above must still pass the five gates — they are not migration
scaffolding, they are the client's invariants:

1. `fullRedraws === 1` through a streaming turn.
2. No history rewrite.
3. Every rendered line fits the width (pi-tui throws otherwise).
4. The pure test suite stays green.
5. `packages/client-core` untouched — the renderer's opportunities are not
   reasons to reach into shared logic.

Entry 0 additionally needs a bench, because no gate can see it: gate 1 stays
green at 38 ms a frame.
