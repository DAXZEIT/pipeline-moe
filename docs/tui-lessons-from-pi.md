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
| paste-dispatch guard (pasted text can't trigger an agent wave) | no | yes (session mrff3qwe) |

## Other pi-tui assets worth knowing about

- **Overlay system**: 9 anchor points, %-based sizing, stacking, `nonCapturing`
  overlays. Our single-overlay model forced the `picking` workaround in
  `RoomForm.tsx` to fake a two-level modal.
- **Inline images** (Kitty / iTerm2 graphics protocols) with reserved-row
  bookkeeping in the diff. Relevant to us: kitty terminal, vision models,
  `/image` currently displays nothing.
- **Theme system** (light/dark, component-level theme interfaces). Our colors
  are hardcoded.
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
4. **Inline kitty images** for `/image` and agent screenshots.
5. **Keybinding registry** — their declarative pattern, even partially adopted.

## Status

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
