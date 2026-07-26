# TUI: lessons from pi-tui

A comparison of our Ink-based TUI (`packages/tui`) against pi's terminal UI
(`@earendil-works/pi-tui`, studied at pi-coding-agent 0.80.10), written to keep
pipeline-moe from regressing on the original pi experience — and to steal what's
worth stealing. Source read on disk at
`~/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/`.

## The fundamental architectural difference

**pi-tui** is a custom framework (~1400-line core, no React). Components render
to plain text lines (`render(width): string[]`); the TUI diffs line-by-line
against the previous frame and only rewrites what changed, wrapped in CSI 2026
synchronized output for atomic, flicker-free updates. The conversation **grows
into the terminal's native scrollback**: appending a message writes new lines
once and never repaints them. Full redraws happen only on width resize (re-wrap)
and a few edge cases (Termux keyboard, shrink-below-working-area).

**Ours** pins a fixed-height Ink frame (`rows-1`) and clips the transcript
inside it with internal scroll state (`Transcript.tsx`: `offset`, ↑/↓ paging).
Our own comments document why: past screen height, Ink's row diffing corrupts
(ghost frames, glyph fragments).

What their choice buys, permanently:

- native terminal scrollback: mouse wheel, text selection, terminal search over
  the whole history;
- no scroll state, no `reservedRows` arithmetic, no clipping;
- render cost independent of conversation length (only the live tail repaints);
- flicker-free streaming via synchronized output (Ink does erase-and-rewrite).

What it costs them: a full clear+redraw on width change (wrap invalidation),
and the whole framework is theirs to maintain.

## Editor vs our CommandLine

Their `Editor` (~1900 lines) is a real editor:

| Capability | pi-tui Editor | our CommandLine |
|---|---|---|
| multiline input | yes | no (`\n` flattened to spaces) |
| prompt history (↑/↓, draft preserved) | yes | no |
| kill-ring / undo stack (Emacs-style) | yes | no |
| large-paste markers (`[paste #1, N lines]`, expanded on submit) | yes | no (raw insert) |
| autocomplete (files + slash commands, debounced, abortable) | yes | command palette on `/` head only |
| grapheme-aware segmentation, IME hardware cursor | yes | no |
| user-remappable keybindings (`tui.editor.*` registry) | yes | hardcoded |
| @mention routing preview | no | yes (`previewRouting`) |
| paste-dispatch guard (pasted text can't trigger an agent wave) | half — buffers bracketed paste so a newline in it is never ⏎, but has no routing preview | yes (session mrff3qwe) |

The "our CommandLine" column is the state at 2026-07-19. Phase 2 of the migration
closed every row of it for `pmoe-next` by adopting their Editor; `pmoe` (Ink) still
reads as written above until Phase 6 deletes it.

## Other pi-tui assets worth knowing about

- **Overlay system**: 9 anchor points, %-based sizing, stacking, `nonCapturing`
  overlays. Our single-overlay model forced the `picking` workaround in
  `RoomForm.tsx` to fake a two-level modal. *Adopted in Phase 3; in Phase 4 the
  `picking` hack was deleted rather than ported — forms push their pickers on top
  of themselves, and the composer runs three layers deep.*
- **Inline images** (Kitty / iTerm2 graphics protocols) with reserved-row
  bookkeeping in the diff. *Adopted in Phase 5 — `/image` and ⌃V now display, in
  the transcript and as a staging preview.* Three things to know: the `Image`
  component emits the sequence on one line plus `rows - 1` blank lines (that shape
  is what the diff understands); image lines are exempt from the width throw and
  must not be prefixed or truncated; and `detectCapabilities` returns
  `images: null` under tmux **on purpose**, so a graphics feature can only be seen
  in the terminal itself.
- **Theme system** (light/dark, component-level theme interfaces). Our colors
  are hardcoded.
- **`SettingsList`** — a label→value list where ⏎ cycles a fixed `values` array or
  opens a submenu that replaces the render. Evaluated for our forms in Phase 4 and
  rejected: no in-place text editing, no submit action, no multi-select, no
  interleaved rows. Still the right component for a genuine settings screen.
- Purpose-built components: colored diff rendering for edit/write receipts,
  fuzzy session selector, past-user-message selector (edit & re-run), footer
  with pwd + git branch + token/context stats.

## Where our TUI is ahead

Different problem domain — pi is in-process and single-agent; ours is a remote
multi-room client. Nothing in pi-tui covers: room tabs + resume, SSE
reconnection, per-agent roster strip with context gauges, task board, seats,
handoff gates, routing preview. `@pipeline-moe/client-core` being UI-agnostic
is the strategic asset: any rendering layer can sit on it.

## Ranked backlog

1. **Native scrollback for the transcript** — the deep fix. Two routes:
   (a) Ink `<Static>` for finalized messages (cheap, but Static content never
   re-wraps on resize and coexists badly with full-frame overlays);
   (b) migrate the rendering layer to `@earendil-works/pi-tui` itself — it's on
   npm, already shipped on this machine, and client-core survives untouched.
   Architecture decision → grill it first; a throwaway prototype (pi-tui
   transcript fed by client-core) would price the migration honestly.
2. **Prompt history + multiline in CommandLine** — small, isolated, daily win.
3. **Large-paste markers** — paste a 200-line log without wrecking the input.
4. ~~**Inline kitty images** for `/image` and agent screenshots.~~ *Done, Phase 5 —
   on `pmoe-next` only, which is one more reason the flip matters.*
5. **Keybinding registry** — their declarative pattern, even partially adopted.

## Status

- 2026-07-27: **(1) Phase 5 shipped — PARITY.** The handoff graph, the prompt
  pager, the OAuth panel, the QCM picker, room switching with the tab strip, ⌃V
  image staging, and inline images. All eleven overlay kinds are served; nothing
  posts a "lands in phase N" notice any more. Findings worth carrying: **`$EDITOR`
  does not have to cost the scrollback** — `requestRender(true)` invalidates the
  dimensions and therefore clears screen *and* scrollback, while `resumeBelow`
  (Phase 2's `!` fix, now exported) forgets the frame and keeps the dimensions, so
  pi-tui re-prints below whatever the child left; measured 1 → 2 on the counter with
  the previous turn still on screen. **pi-tui refuses image protocols under tmux**
  by design, which is a verification constraint, not a bug. **Image lines need
  reference stability**: the transcript returns every line each frame, so the
  `Image` instances are cached and the same string comes back — otherwise the diff
  re-compares (and the encoder re-produces) a megabyte of base64 per token. And a
  room switch legitimately costs one full redraw (`firstChanged < viewportTop`),
  because the whole transcript changes including lines that scrolled away — the same
  mechanism the layout order exists to avoid for ordinary chrome updates.

- 2026-07-26: **(1) Phase 4 shipped** — the four forms. `SettingsList` was
  evaluated and does not fit (no in-place text editing, no submit action, no
  multi-select, no interleaved preview rows), so the win came from elsewhere: the
  four Ink forms were four copies of one keyboard loop, and writing it once
  (`src/next/form.ts`, five row kinds) turns them into declarations. The engine adds
  what Ink could not — row windowing, because pi-tui's `maxHeight` truncates rather
  than shrinks, and explicit chip wrapping instead of Yoga's `flexWrap`. Real
  stacking replaces the `picking` hack: a form pushes its picker on top of itself,
  and the composer runs roster → member card → model catalogue three deep. Two
  findings worth carrying: `overlay-frame.ts` was measuring width with `string-width`
  for padding and with the stricter of two measures for fitting, and **both were
  wrong** — `▶` is East Asian Ambiguous, so a focused row shipped one column short
  of its border while a full-width row got cropped; there is one ruler now, pi-tui's,
  and the tests no longer measure with the same wrong one as the code. And the member
  card's legend said "esc cancel" beside a key that commits.

- 2026-07-26: **(1) Phase 3 shipped** — the five generic overlays. pi-tui's
  overlay system (9 anchors, %-sizing, real stacking, focus restore) replaces the
  Ink client's single full-frame modal, and 509 lines of JSX become a `SelectList`
  picker, an `Input` prompt and three components rendering into one pure
  `overlay-frame.ts` box. The registry dispatches unchanged. Findings:
  `SelectList.setFilter` is a prefix match on `value`, so the real fuzzy filter is
  `fuzzyFilter` from `fuzzy.ts`; `SelectList` fixes its items and window height at
  construction; and `maxHeight` truncates rather than shrinks, so a windowed list
  must budget its own rows or lose its key legend on a short screen. The
  `SelectOverlay`'s `▲/▼ more` markers and right-aligned hints are given up on
  list pickers in exchange for code we no longer own.
- 2026-07-26: **(1) Phase 2 shipped** — the input. pi-tui's `Editor` replaces
  `CommandLine` on `pmoe-next`: multiline, history, kill-ring, undo, paste markers
  and grapheme segmentation come from the library, while the slash palette and
  `@mention` completion became a pure function of the draft
  (`src/next/autocomplete.ts`). Backlog items (2), (3) and (5) are absorbed by
  this — their Editor already does prompt history, paste markers and a keybinding
  registry, and Alt+⏎ is added back through it. `commands/registry.ts` dispatches
  unchanged from both clients. Three findings: their `Editor` **resets itself
  before** calling `onSubmit` and passes the text as the argument (reading it back
  is silently empty — it cost every slash command a no-op); `clearOnShrink`
  defaults OFF and the `.d.ts` claims the opposite, which is the only reason
  height-changing chrome is free; and `!` shell can resume BELOW its output
  instead of clearing, which is better than what Ink could do.
- 2026-07-26: **(1) Phase 1 shipped** — chrome moved BELOW the conversation
  (`src/chrome-lines.ts`: tabs, roster strip, tasks, notices, status bar) and the
  turn-finalization rewrite is fixed: the header rule no longer gains a duration
  (it closes the turn instead) and the thought head no longer flips word. Gate 1
  now holds on a 16-row screen, which used to cost 6 full redraws. Two new
  findings: chrome height has a per-token streaming cost (~39 B/line), so the
  honest advantage over Ink is ~5× with real chrome rather than 39×; and
  `string-width` and pi-tui disagree on `▶`, which silently breaks line
  accounting unless the stricter measure wins.
- 2026-07-26: **(1) Phase 0 shipped** — see `docs/tui-pitui-migration-plan.md`.
  One transcript renderer (`src/transcript-lines.ts`) now serves both clients;
  `pmoe` (Ink) is untouched and `pmoe-next` (pi-tui) ships beside it. All five
  gates pass. The phase found the real blocker for Phase 1: a turn's two
  finalization rewrites sit at the TOP of its block, so any turn taller than the
  viewport clears the scrollback when it lands (120×40 → 1 full redraw, 120×16 →
  6). Both causes are ours, and the fix is in the flatten.
- 2026-07-26: **(1) prototyped and priced** — see `docs/tui-pitui-prototype.md`.
  Ink's write path costs 22–55× more bytes per streamed token than pi-tui's
  (it scales with the SCREEN, not the change); client-core survives untouched;
  our transcript renderer already *is* a `render(width): string[]`. The cost is
  overlays plus one visible product change: all chrome must move BELOW the
  conversation, or every roster update clears the scrollback it was meant to
  preserve. Route (b) — migrate to pi-tui — is the one that was prototyped.
- 2026-07-19: doc written from source study. (1) parked pending grill.
- 2026-07-19: quick wins (2) and (3) shipped — prompt history
  (`prompt-history.ts`: ↑/↓ on a non-empty draft, draft parked/restored;
  empty line keeps the arrows for wheel scrolling) and paste markers
  (`paste-markers.ts` + bracketed paste mode 2004 in `cli.tsx`: 5+-line
  pastes collapse to `[#n paste +L lines]`, expand at send, atomic
  backspace, routing preview sees the expanded text).
- 2026-07-19: multiline input shipped (`multiline-input.ts`): Alt+⏎ or
  `\`+⏎ insert a newline; ↑/↓ move between lines and only fall through to
  history at the draft's edges (pi's arbitration); the box windows at 6
  rows around the cursor (⋮ markers) and books its extra rows in the
  Transcript's reservedRows. Two Ink lessons paid for en route, both
  documented in CommandLine.tsx: (a) CommandLine→App state updates are
  not reliably batched, so grow-vs-shrink ordering must keep any
  intermediate frame too short rather than too tall; (b) nested <Text>
  runs inside a flex row get fragmented widths from Yoga — compose each
  line as one string with raw ANSI for the cursor, as Transcript already
  does for markdown.
