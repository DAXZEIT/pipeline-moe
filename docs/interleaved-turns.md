# Interleaved turns — chronology inside the entry envelope

> Grilling 2026-07-25 (dax + Opus 5). Decisions taken are marked as such; what
> is still open is listed at the end. No code written yet.

## The idea in one line

A turn currently renders as three boxes grouped BY TYPE — all the reasoning,
then all the tool calls, then the text. It should render in the order it
actually happened: `CoT 1 → tool 1 → CoT 2 → tool 2 → … → reply`, inside the
same `── Planner · 1m37s ──` envelope it has today.

## The blocker: the ordering is destroyed at collection, not at rendering

This is not a renderer change. `src/participant.ts:209` and `:212`:

```ts
if (me.type === "text_delta")           { this.buffer += me.delta }
else if (me.type === "thinking_delta")  { this.reasoningBuffer += me.delta }
```

Two `+=` for the whole turn. A turn that reasons, calls a tool, reasons again
and replies produces ONE reasoning blob and ONE text blob. `TranscriptEntry`
(`src/types.ts:63`) mirrors that shape — `{ text, reasoning?, activity? }`, no
ordering relation between the three — and `Transcript.tsx:180-181` renders
exactly what it receives. The grouped layout is not a design choice anyone made;
it is the only thing the data supports.

Tool calls are the exception: each `ToolActivity` carries `ts`, so tools are
ordered among themselves. Text and reasoning have no timestamps and no
segmentation.

**The seams are provable.** In dax's own transcript (screenshot 2026-07-25, the
`feat(web): seat controls` turn), the reasoning blob reads:

```
…everything's green and safe to push.Root typecheck passed with all 87 files…
…which means those two are clean.Web doesn't have a typecheck script…
…double-check that build is actually working.All the type checks are passing…
```

`push.Root`, `clean.Web`, `working.All` — the missing space is the `+=` seam.
Each one is an assistant-message boundary, i.e. a CoT segment that happened
AFTER a tool call. That single blob held 4-5 distinct thoughts. Today's grouped
rendering therefore also has a cosmetic bug (glued sentences) that segmentation
fixes for free.

**The trap.** The order exists LIVE: the `emit("token"/"reasoning"/"activity")`
calls fire in true sequence, and the TUI already keeps live text, live reasoning
and live activity apart (`Transcript.tsx:216-225`) before dispatching them into
three boxes. So rewiring only the renderer yields correct chronology during a
turn and silent regrouping on reload — a data bug that looks like a rendering
bug, hunted in the wrong file. This is the "hidden persisted state" the
`invariants` skill says to find before designing.

## Design

### 1. `parts` is additive — zero migration

```ts
parts?: TurnPart[]
// { type: "reasoning" | "text", content, lines, ts }
// { type: "tool", toolCallId }
```

`text` / `reasoning` / `activity` stay populated exactly as today. Three
verified reasons: `sessions/` holds real history whose entries have no `parts`;
`buildContext` and `roomTranscriptTokens()` read `text`/`reasoning` to build
prompts; receipts read `activity`. So `parts` is presentation metadata, and the
renderer falls back to today's grouped layout when it is absent — same
back-compat shape as the `(no response)` fix. Same additive pattern as
`mode` (supervised routing) and `seat?` (fused seats).

A tool part REFERENCES its activity by `toolCallId` instead of copying it: the
live path that flips a tool `running → ok` in place keeps working untouched, and
the part stays a pointer.

### 2. Segmentation trigger: delta-type flip or tool start

Close the current segment when the delta type changes (`text_delta` ↔
`thinking_delta`) or when `tool_execution_start` arrives. All of it inside
`Participant.onEvent`, which already sees every event.

This deliberately does NOT depend on pi's assistant-message boundary event. The
flip rule produces exactly the seams observed above, it also catches
reasoning → text → reasoning inside a single message, and it removes a
dependency on a pi API surface we would otherwise have to track across bumps.

### 3. One source of truth for boundaries — the server emits them

Live chronology could be re-derived client-side from the event stream, but then
segmentation exists twice (server for persistence, client for live) and the two
must agree forever. Instead the server emits the boundary it already computes;
the client appends. Live and persisted are identical BY CONSTRUCTION, not by
two implementations happening to match. The reducer lives in `client-core`, so
both clients share it (keep the clients thin).

### 4. Collapsed = one line per segment — DECIDED (dax, 2026-07-25)

`Ctrl+T` collapses each segment to a single line (`💭 thought · 4 l`), not the
turn into one block. Collapsing the whole turn returns to the grouped view we
are leaving.

The counter-intuitive part: the interleaved view is MOST useful collapsed.
Expanded, a verbose 27B drowns the reply; collapsed, the shape of the turn
(`💭 → 🔧 → 💭 → 🔧`) is readable at a glance and you expand the suspect
segment. Consequence for the field: `parts` must carry a per-segment metric
(`lines`), or the renderer has to re-wrap every blob just to print a count.

### 5. Windowing: extend `windowActivity` to the sequence — DECIDED (dax, 2026-07-25)

At ~16 tool calls per turn (measured below), a fully collapsed turn is still
~32 lines. `windowActivity` already windows the tool block with pinned errors;
the same semantics extend to the whole sequence: first and last segments
visible, middle reduced to `⋯ N segments hidden (^O expands) ⋯`, errors always
pinned regardless of position. Chronology and turn shape survive; the middle
expands on demand.

Rejected: collapsing finished turns to reply-only with a one-line shape summary
(`💭🔧 ×16 · 4 errors`). Denser across 20 turns, but it hides the very shape
decision 4 exists to expose.

## Measurement (2026-07-25, `sessions/default/mqipjpxe-u6cq12.json`, 2.25 M)

```
entries          111   (63 with reasoning)      tool calls  1014
text total       124K
reasoning total  133K   → ratio 1.07× (near parity, not the dwarfing assumed)
activity (JSON) 1817K   → 79% of the file
```

Two conclusions, both load-bearing:

- **Content goes in the parts.** Duplicating text + reasoning costs +256K on
  2307K = **+11%**. The alternative (offsets into the blobs) buys that 11% and
  breaks the moment `room.ts` appends ` _(interrupted — partial)_` to the text
  after the fact. Bad trade, closed.
- **~16 tool calls per agent turn**, so ~32 interleaved segments. Windowing is
  not a nice-to-have, it is what makes the layout usable at all.

Aside, not this chantier: 79% of persisted conversation volume is clipped tool
results. If `sessions/` size (67 M) ever matters, `clip()` is the lever — not
the reasoning traces.

## What this deliberately does NOT do

- **No change to prompt building.** `text`/`reasoning` keep feeding
  `buildContext` and the token gauge. Agents see what they see today.
- **No migration of `sessions/`.** Old entries have no `parts` and render
  grouped, forever. No rewrite pass over 67 M of history.
- **No per-part timing.** Tools have `ts`; text and reasoning segments get one
  too, but the turn's single `durationMs` stays the only duration displayed.
- **Not a Claude Code clone.** Claude Code and pi render ONE agent. Here a
  transcript interleaves N seats and the entry is the unit of attribution, so
  the envelope (author, seat, duration, handoff stamp) stays. Chronological
  INSIDE the entry, never across entries.

## Découpage (blocks, scope + verification criterion stated before building)

1. **Segmentation + type** — ✅ SHIPPED 2026-07-25. `src/turn-parts.ts`
   (`TurnSegmenter`), `TurnPart` in `types.ts` and mirrored in
   `client-core/src/types.ts`, `parts` threaded `Participant.run`/`followUp` →
   `RunOutput` → `post()` → entry. 13 pure tests in
   `src/__tests__/turn-parts.test.ts` on a synthetic event sequence
   (reason → tool → reason → text → tool): order, contiguous-delta merging,
   type-flip boundary without a tool, `lines`, whitespace-only runs dropped,
   `reset()` bleed, ordering-by-construction. Full suite 1399 green, four
   typechecks clean. No UI, no client behaviour change.

   Two things the build settled that the design had left implicit:

   - **`lines` was worth checking before typing it.** Measured on 63 real
     reasoning entries: median 91 chars/line, only 6 single-line. The model
     does emit newlines, so a raw newline count carries information. (Wrapped
     line count stays the renderer's job — it needs a width.)
   - **`entry.text` is a COMPOSED body, not the concatenation of the text
     parts.** `turnBody()` adds the question callout and `(no response)`, and
     room.ts appends ` _(interrupted — partial)_` after the fact. A renderer
     drawing parts would show a truncated reply with no sign it was cut off —
     which is the one thing the salvage marker exists to prevent (F7).
     `appendBodyMarker()` mirrors it onto the last text part at post time.
     The question callout is the same class of problem, still open (see below).
2. **Boundary event + `client-core` reducer** — placed second on purpose: this
   is the fact capable of invalidating the design. Verified live on an isolated
   instance (`PORT=5399`, throwaway workspace): run one real multi-tool turn,
   then assert the live-assembled `parts` are identical to the persisted entry.
   If they can't be made identical by construction, blocks 3-4 change shape.
3. **TUI renderer** — per-segment collapse + sequence windowing + pinned
   errors. Verified by screenshot, not by `capture-pane`: this is a rendering
   change, and the vision heuristic applies (the text says what the lines said,
   not what the screen shows).
4. **Back-compat replay** — load a real pre-`parts` conversation from
   `sessions/`, assert the grouped fallback renders exactly as today. Cheap, and
   it protects 67 M of history.
5. **Web renderer** — same `parts`, same reducer, browser layout.

Blocks 1-2 are the architecture proof; 3-5 thicken it. Block 4 could fold into
3, kept separate because it is the only block that reads dax's real history.

## Decisions taken (dax, 2026-07-25)

- Keep the entry envelope, interleave inside it.
- Collapse per segment to one line, not per turn.
- Window the sequence with pinned errors; reject reply-only turns.
- Content in the parts, not offsets (settled by the +11% measurement).

## Open

- **TUI first or both clients together?** `client-core` carries the reducer, so
  the web renderer is cheap once block 3 exists — but "cheap" is not "free" and
  the two surfaces drift if one lags.
- **Does `ask_user` take a part?** The question is currently a callout after the
  body. Chronologically it belongs where it fired. Sharpened by block 1: this
  is not cosmetic but the same gap as the salvage marker — `entry.text` is a
  composed body, so a parts renderer that ignores what `turnBody()` adds drops
  it. `ask_user` IS a tool call, so its part already exists; the open question
  is only whether the renderer draws the callout at the tool part's position
  instead of after the body. Decide at block 3.
- **Reasoning-budget interaction.** `reasoning-budget.ts` aborts a generation
  mid-thought and re-prompts; the resulting continuation currently glues onto
  the same blob. Segmented, it becomes a visible seam — probably an improvement
  (the watchdog fires where you can see it), unverified.
