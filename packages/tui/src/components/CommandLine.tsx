import { Box, Text, useInput } from "ink"
import { useEffect, useRef, useState } from "react"
import { commandPaletteLabel, matchCommands } from "../commands/registry"
import { shouldAbortOnEscape } from "../escape-behavior"
import { pickerKeyAction, pickerVisible } from "../answer-picker"
import { inputBorderColor, inputMode, inputModeHint } from "../input-mode"
import { expandPastes, isPastey, markerSpanAt, newPasteStore, stashPaste } from "../paste-markers"
import { newPromptHistory, pushPrompt, recallNext, recallPrev } from "../prompt-history"
import { MAX_INPUT_ROWS, lineBounds, moveVertical, visibleWindow, wrapDraft } from "../multiline-input"
import { useTerminalSize } from "../useTerminalSize"
import { previewRouting } from "@pipeline-moe/client-core"
import type { RosterItem, RoutingMode } from "@pipeline-moe/client-core"

/**
 * The input line. Plain text is sent as a room message; a leading "/" turns it
 * into a command, with a live fuzzy palette (Claude-Code style) while typing the
 * command name. Enter dispatches; Tab completes the highlighted command; Esc
 * clears — or, on an EMPTY line while a turn is running, aborts it (F7:
 * one-keystroke parity with the WebUI's Stop button, reusing an otherwise-idle
 * Esc slot rather than overloading Ctrl+C, which terminals treat as "kill the
 * process", not "cancel the current action"). Editing is full-line: ←/→ move
 * the cursor, Ctrl+A/Ctrl+E jump to start/end, Backspace/Delete cut around it,
 * and typing inserts at the cursor. Gated by `isActive` so overlays can take
 * over the keyboard.
 */
export function CommandLine({
  onSend,
  onCommand,
  onRoomNav,
  onEmptyEnter,
  onRoutingCycle,
  onShell,
  onScroll,
  onPaste,
  onToggleTasks,
  onRosterMenu,
  onAbort,
  turnActive,
  routingMode,
  answerOptions,
  pausedAskerId,
  pasteInsertRef,
  pendingImageCount,
  onClearPending,
  roster,
  defaultAgent,
  onRoutingPreview,
  onDraftRows,
  isActive,
  connected,
}: {
  onSend: (text: string) => void
  onCommand: (input: string) => void
  /** ←/→ on an empty line cycles rooms (the arrows keep their cursor role while typing). */
  onRoomNav?: (dir: -1 | 1) => void
  /** ⏎ on an empty line — used by the tab bar's "+ room" tab. */
  onEmptyEnter?: () => void
  /** ⇧⇥ cycles the routing mode (auto → semi → manual → supervised). */
  onRoutingCycle?: () => void
  /** "!" shell mode: run a command in the room's workspace (shared context). */
  onShell?: (command: string) => void
  /** ↑/↓ outside the palette scrolls the transcript (+up / −down, one line per
   *  press) — the mouse wheel sends exactly these keys in alternate-scroll mode. */
  onScroll?: (delta: number) => void
  /** Ctrl+V — triggers an async clipboard read in the parent (image → sent
   *  straight to the room; text → comes back through pasteInsertRef). */
  onPaste?: () => void
  /** Ctrl+P — opens the shared task board overlay. */
  onToggleTasks?: () => void
  /** Ctrl+R — opens the per-agent roster menu (same as /roster). */
  onRosterMenu?: () => void
  /** Esc on an empty line with no pending image — only wired up when
   *  `turnActive` is true (otherwise Esc's existing clear behavior on an
   *  already-empty line stays a no-op, unchanged). Same effect as /abort. */
  onAbort?: () => void
  /** Whether a turn is currently running — gates the Esc-to-abort shortcut. */
  turnActive?: boolean
  /** Current handoff routing mode — the plain-text border color follows it
   *  (cyan auto / blue semi / gray manual), so the box itself tells you how a
   *  message will dispatch. "/" and "!" override with yellow/red. */
  routingMode?: RoutingMode
  /** Closed answer choices while the room is paused on an ask_user question —
   *  renders the QCM picker above the input (↑↓⏎ or 1-N to answer; typing
   *  stays free text). Null/empty = no picker, plain answer as before. */
  answerOptions?: string[] | null
  /** Who is asking — shown in the picker title. */
  pausedAskerId?: string | null
  /** Published by this component so the parent can insert clipboard text at
   *  the current cursor position after an async read — same pattern as
   *  Transcript's scrollRef. */
  pasteInsertRef?: React.MutableRefObject<(text: string) => void>
  /** Images staged via Ctrl+V, waiting to go out with the next ⏎ send —
   *  owned by the parent (same store as the image bytes themselves), this
   *  component only needs the count for the indicator and to let an
   *  empty-text ⏎ still send (image-only message). */
  pendingImageCount?: number
  /** Esc clears staged images along with the text — the parent owns the
   *  images, so this component can't clear them itself. */
  onClearPending?: () => void
  /** Live roster + room default — feeds the routing preview under the input:
   *  a draft with explicit @mentions shows exactly who will run BEFORE send,
   *  so a pasted transcript quoting agent handles can't dispatch a surprise
   *  wave (session mrff3qwe: a pasted report routed @builder and @tester). */
  roster?: RosterItem[]
  defaultAgent?: string | null
  /** Fires when the draft's explicit routing changes: `{t: targetIds, d: dropped}`
   *  while the draft @mentions agents (or @all), null otherwise. Rendered by
   *  the parent in the StatusBar — a stable row, not a new one. */
  onRoutingPreview?: (p: { t: string[]; d: string[] } | null) => void
  /** Reports how many rows the draft currently occupies (1..MAX_INPUT_ROWS) —
   *  the App books the extra rows in the Transcript's reservedRows so a
   *  growing multiline draft shrinks the conversation instead of overflowing
   *  the fixed-height frame. */
  onDraftRows?: (rows: number) => void
  isActive: boolean
  connected: boolean
}) {
  const [value, setValue] = useState("")
  const [cursor, setCursor] = useState(0)
  const { columns } = useTerminalSize()
  // Large pastes collapse to a `[#n paste +L lines]` marker instead of being
  // flattened into one giant line; markers expand back at send time. The store
  // lives for the session so history recall can re-expand old markers.
  const pastes = useRef(newPasteStore())
  // Prompt history (↑/↓ while a draft exists — see prompt-history.ts for the
  // arbitration with transcript scrolling on an empty line).
  const hist = useRef(newPromptHistory())
  const exitHistory = () => {
    hist.current.index = -1
    hist.current.draft = ""
  }
  const [pIndex, setPIndex] = useState(0)
  // QCM picker state — highlight + per-question dismissal. Both reset when a
  // new question (different options array) arrives.
  const [aIndex, setAIndex] = useState(0)
  const [aDismissed, setADismissed] = useState(false)
  useEffect(() => {
    setAIndex(0)
    setADismissed(false)
  }, [answerOptions])
  const picker = pickerVisible({ options: answerOptions ?? null, value, dismissed: aDismissed })
  const opts = answerOptions ?? []

  // Synchronous mirrors of value/cursor. Ink dispatches ONE useInput call per
  // parsed key, so a multi-char stdin chunk ("zzz" from a fast typist or
  // tmux) runs this handler several times in the same React flush — every
  // call reading the render-scoped `value` would see the same stale draft and
  // clobber the previous call's insert. All mutations read these refs.
  const valueRef = useRef("")
  const cursorRef = useRef(0)

  // Every draft mutation flows through here so the refs stay current within
  // a flush and the App's reservedRows follows the draft's height. Batching
  // between this component's state and the App's is NOT guaranteed under
  // Ink's reconciler, so the two commits are ORDERED such that any
  // intermediate frame is too SHORT (a blank row — harmless) rather than too
  // TALL (layout exceeds the screen for one frame and Ink's row diffing
  // corrupts durably, the 2026-07-09 artifact): growing books the rows
  // first; shrinking updates the text first. Verified live — the
  // report-after-commit variant (an effect) corrupts reproducibly.
  const lastRowsRef = useRef(1)
  const setDraft = (next: string, cur: number) => {
    valueRef.current = next
    cursorRef.current = cur
    const rows = next ? Math.min(next.split("\n").length, MAX_INPUT_ROWS) : 1
    const growing = rows > lastRowsRef.current
    lastRowsRef.current = rows
    if (growing) onDraftRows?.(rows)
    setValue(next)
    setCursor(cur)
    if (!growing) onDraftRows?.(rows)
  }
  /** Pure cursor moves also keep the ref current — a later insert in another
   *  flush must not see a stale position. */
  const setCur = (cur: number) => {
    cursorRef.current = cur
    setCursor(cur)
  }

  // Shared insertion for typed chunks and clipboard text: a big paste (5+
  // lines) becomes a marker, a small one keeps its real newlines — the draft
  // is multiline now, rendered as a windowed stack of rows below. Terminals
  // send a paste's newlines as \r — normalize before counting lines. `prefix`
  // carries text glued ahead of a bracketed paste in the same stdin chunk.
  const insertAtCursor = (raw: string, prefix = "") => {
    const norm = raw.replace(/\r\n?/g, "\n")
    const text = prefix + (isPastey(norm) ? stashPaste(pastes.current, norm) : norm)
    exitHistory()
    const v = valueRef.current
    const c = cursorRef.current
    setDraft(v.slice(0, c) + text + v.slice(c), c + text.length)
  }

  if (pasteInsertRef) pasteInsertRef.current = insertAtCursor

  // Bracketed-paste accumulator (cli.tsx enables mode 2004). The whole paste
  // usually arrives as ONE stdin chunk `ESC[200~ … ESC[201~`; Ink strips the
  // leading ESC, so the start marker reaches us as "[200~". A paste can still
  // split across chunks — buffer until the end marker shows up. Non-null =
  // currently inside a paste.
  const pasteAccum = useRef<string | null>(null)
  const BP_START = "[200~"
  const BP_END = "[201~"

  const isSlash = value.startsWith("/")
  const isBang = value.startsWith("!")
  const head = isSlash ? value.slice(1).split(" ")[0] : ""
  const showPalette = isSlash && !value.includes(" ") && !value.includes("\n")
  const matches = showPalette ? matchCommands(head) : []
  const idx = matches.length ? Math.min(pIndex, matches.length - 1) : 0

  const reset = () => {
    setDraft("", 0)
    setPIndex(0)
  }

  useInput(
    (input, key) => {
      // Bracketed paste owns the stream first: while inside a paste, every
      // chunk is content (a chunk-boundary \r would otherwise be parsed by
      // Ink as a spurious Enter), and a chunk carrying the start marker is
      // split into before-text / payload / after-text.
      if (pasteAccum.current !== null) {
        const s = input || (key.return ? "\r" : "")
        const end = s.indexOf(BP_END)
        if (end === -1) {
          pasteAccum.current += s
          return
        }
        // The end marker's own ESC can sit inline in the chunk ("…q5\x1b[201~")
        // — the "[201~" search lands after it, so strip it off the payload.
        const payload = (pasteAccum.current + s.slice(0, end)).replace(/\x1b$/, "")
        pasteAccum.current = null
        insertAtCursor(payload)
        return
      }
      const bpStart = input ? input.indexOf(BP_START) : -1
      if (bpStart !== -1) {
        // Text typed ahead of the paste in the same chunk (minus the orphan
        // ESC that Ink left glued to it) inserts normally first.
        const before = input.slice(0, bpStart).replace(/\x1b$/, "")
        const after = input.slice(bpStart + BP_START.length)
        const end = after.indexOf(BP_END)
        if (end === -1) {
          if (before) insertAtCursor(before)
          pasteAccum.current = after
          return
        }
        insertAtCursor(after.slice(0, end).replace(/\x1b$/, ""), before)
        return
      }
      // ⇧⇥ cycles routing anytime the command line owns the keyboard — checked
      // before the palette's plain-Tab completion, which must not swallow it.
      if (key.tab && key.shift) {
        onRoutingCycle?.()
        return
      }
      // QCM picker owns ↑/↓/⏎/digits/Esc while visible (same precedent as the
      // slash palette). Any other key falls through — typing IS the free-text
      // answer, no mode to leave.
      if (picker) {
        const action = pickerKeyAction(input, key, opts.length, aIndex)
        if (action.kind === "move") {
          setAIndex((i) => (i + action.delta + opts.length) % opts.length)
          return
        }
        if (action.kind === "submit") {
          onSend(opts[action.index])
          reset()
          return
        }
        if (action.kind === "dismiss") {
          setADismissed(true)
          return
        }
        // passthrough: fall into the normal handlers below
      }
      if (key.return) {
        const v = valueRef.current
        const c = cursorRef.current
        // Alt+⏎ (ESC CR → key.meta) inserts a newline. The other multiline
        // gesture — a "\" right before ⏎, Claude Code's — works in terminals
        // that swallow the Alt chord: the backslash becomes the newline.
        if (key.meta || (c > 0 && v[c - 1] === "\\")) {
          exitHistory()
          const at = key.meta ? c : c - 1
          setDraft(v.slice(0, at) + "\n" + v.slice(c), at + 1)
          return
        }
        // Markers expand here, at the last moment — everything downstream
        // (send, /command, !shell) sees the full pasted text.
        const text = expandPastes(pastes.current, v).trim()
        // A staged image can go out with no text at all (image-only message,
        // mirrors the web UI's Composer) — so an empty line with a pending
        // image is a send, not the "+ room" tab's onEmptyEnter.
        if (text || (pendingImageCount ?? 0) > 0) {
          // While the palette is open, Enter runs the highlighted command
          // (so "/r"⏎ on ▶/resume runs /resume, not the ambiguous "/r").
          if (matches.length > 0) onCommand("/" + matches[idx].matched)
          else if (text.startsWith("/")) onCommand(text)
          else if (text.startsWith("!") && onShell) {
            const cmd = text.slice(1).trim()
            if (cmd) onShell(cmd)
          } else onSend(text)
          // History stores the line as typed (markers included — the session
          // paste store outlives the send, so recall re-expands fine).
          pushPrompt(hist.current, v.trim())
        } else if (onEmptyEnter) {
          onEmptyEnter()
        }
        reset()
        return
      }
      if (key.escape) {
        if (shouldAbortOnEscape({ turnActive, hasOnAbort: !!onAbort, value, pendingImageCount })) {
          onAbort!()
          return
        }
        onClearPending?.()
        reset()
        return
      }
      if (matches.length > 0 && key.tab) {
        const next = "/" + matches[idx].matched + " "
        setDraft(next, next.length)
        setPIndex(0)
        return
      }
      // Palette navigation owns ↑/↓ only while it's open; the cursor owns ←/→.
      if (matches.length > 0 && key.upArrow) {
        setPIndex((p) => (p - 1 + matches.length) % matches.length)
        return
      }
      if (matches.length > 0 && key.downArrow) {
        setPIndex((p) => (p + 1) % matches.length)
        return
      }
      // Outside the palette the arrows are arbitrated by the draft: a
      // non-empty line owns ↑/↓ for prompt history (draft parked/restored,
      // pi's Editor behavior); an empty line keeps them for transcript
      // scrolling — which is also what the mouse wheel emits in the alt
      // screen (alternate-scroll mode 1007), and idle wheel-reading is the
      // dominant empty-line case. Ctrl+↑/↓ is left alone here — Transcript's
      // own useInput claims that combo to jump to the very top/bottom (see
      // the final ctrl/meta/tab catch-all below, which swallows it before it
      // can insert text).
      if (key.upArrow && !key.ctrl) {
        if (value) {
          // Inside a multiline draft the cursor moves between lines first;
          // history only takes over from the FIRST line (pi's arbitration).
          const moved = moveVertical(value, cursor, -1)
          if (moved !== null) {
            setCur(moved)
            return
          }
          const recalled = recallPrev(hist.current, value)
          if (recalled !== null) setDraft(recalled, recalled.length)
          return
        }
        onScroll?.(1)
        return
      }
      if (key.downArrow && !key.ctrl) {
        if (value) {
          const moved = moveVertical(value, cursor, 1)
          if (moved !== null) {
            setCur(moved)
            return
          }
          const recalled = recallNext(hist.current)
          if (recalled !== null) setDraft(recalled, recalled.length)
          return
        }
        onScroll?.(-1)
        return
      }
      if (key.leftArrow) {
        if (!value && onRoomNav) return onRoomNav(-1)
        setCur(Math.max(0, cursorRef.current - 1))
        return
      }
      if (key.rightArrow) {
        if (!value && onRoomNav) return onRoomNav(1)
        setCur(Math.min(valueRef.current.length, cursorRef.current + 1))
        return
      }
      // Ctrl+A/E: start/end of the CURRENT LINE (identical to whole-draft
      // start/end while the draft is single-line).
      if (key.ctrl && input === "a") {
        setCur(lineBounds(value, cursor).start)
        return
      }
      if (key.ctrl && input === "e") {
        setCur(lineBounds(value, cursor).end)
        return
      }
      if (key.ctrl && input === "v") {
        onPaste?.()
        return
      }
      if (key.ctrl && input === "p") {
        onToggleTasks?.()
        return
      }
      if (key.ctrl && input === "r") {
        onRosterMenu?.()
        return
      }
      if (key.backspace) {
        const v = valueRef.current
        const c = cursorRef.current
        if (c > 0) {
          exitHistory()
          // A paste marker deletes atomically — eating it char-by-char would
          // leave a mangled literal that no longer expands.
          const span = markerSpanAt(v, c, "ending")
          const from = span ? span.start : c - 1
          setDraft(v.slice(0, from) + v.slice(c), from)
        }
        return
      }
      if (key.delete) {
        const v = valueRef.current
        const c = cursorRef.current
        exitHistory()
        // Some terminals map Backspace to the Delete key; treat it as backspace
        // when there's nothing to the right, otherwise as a forward delete.
        if (c < v.length) {
          const span = markerSpanAt(v, c, "starting")
          const to = span ? span.end : c + 1
          setDraft(v.slice(0, c) + v.slice(to), c)
        } else if (c > 0) {
          const span = markerSpanAt(v, c, "ending")
          const from = span ? span.start : c - 1
          setDraft(v.slice(0, from), from)
        }
        return
      }
      if (key.ctrl || key.meta || key.tab) return
      if (input) insertAtCursor(input)
    },
    { isActive },
  )

  // The visible text drops the leading "/" or "!" (shown as a colored prompt
  // glyph), so the cursor maps one slot left in slash/bang mode. The draft is
  // soft-wrapped to the box width into VISUAL rows (a long line grows the box
  // downward instead of being clipped with an ellipsis), then windowed around
  // the cursor's row past MAX_INPUT_ROWS.
  const disp = isSlash || isBang ? value.slice(1) : value
  const dcur = isSlash || isBang ? Math.max(0, cursor - 1) : cursor
  // Body width = terminal columns − round border (2) − paddingX (2) − the
  // 2-col gutter ("› " / "/ " / "  " / "⋮ "). Every visual row fits this, so
  // the per-row `truncate-end` below never actually truncates.
  const bodyWidth = Math.max(8, columns - 6)
  const { rows: vRows, cursorRow: cRow, cursorCol: cCol } = wrapDraft(disp, dcur, bodyWidth)
  const win = visibleWindow(vRows.length, cRow, MAX_INPUT_ROWS)
  const draftRows = value ? win.end - win.start : 1
  useEffect(() => {
    onDraftRows?.(draftRows)
  }, [draftRows, onDraftRows])

  // The border speaks the mode: "/" yellow, "!" red, plain text follows the
  // routing mode (cyan auto / blue semi / gray manual). Dead input dims.
  const mode = inputMode(value)
  const live = isActive && connected
  const border = inputBorderColor(mode, routingMode ?? "auto", live)
  // Name the mode while its command part is still empty — the bare glyph
  // ("! ") gave no feedback that the input switched semantics.
  const modeHint = disp.length === 0 && value ? inputModeHint(mode) : null
  // Routing preview: only plain messages route. Reported UP to the parent
  // (rendered in the StatusBar) instead of adding a row here — the transcript
  // height math reserves fixed rows, and a line that appears per keystroke
  // is exactly the jumping layout that doctrine forbids.
  const previewKey =
    mode === "text" && value.trim() && roster && roster.length > 0
      ? (() => {
          // Preview the EXPANDED text: a paste marker can hide @mentions, and
          // the preview must show exactly what send will route (mrff3qwe).
          const p = previewRouting(expandPastes(pastes.current, value), roster, defaultAgent ?? null)
          return p.kind === "mentions" || p.kind === "all"
            ? JSON.stringify({ t: p.targetIds, d: p.dropped })
            : null
        })()
      : null
  useEffect(() => {
    onRoutingPreview?.(previewKey ? (JSON.parse(previewKey) as { t: string[]; d: string[] }) : null)
  }, [previewKey, onRoutingPreview])

  return (
    <Box flexDirection="column">
      {picker ? (
        <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text color="magenta">
            🤚 {pausedAskerId ? `@${pausedAskerId} asks — ` : ""}pick an answer or just type your own
          </Text>
          {opts.map((o, i) => (
            <Text key={i} color={i === aIndex ? "magenta" : undefined} inverse={i === aIndex}>
              {i === aIndex ? "▶ " : "  "}
              {i + 1} {o}
            </Text>
          ))}
          <Text dimColor>1-{opts.length} answer · ↑↓ ⏎ pick · type = custom · Esc hide</Text>
        </Box>
      ) : null}
      {matches.length > 0 ? (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          {matches.map((m, i) => (
            <Box key={m.command.name} justifyContent="space-between">
              <Text color={i === idx ? "yellow" : undefined} inverse={i === idx}>
                {i === idx ? "▶ " : "  "}{commandPaletteLabel(m)}
              </Text>
              <Text dimColor> {m.command.summary}</Text>
            </Box>
          ))}
          <Text dimColor>↑↓ select · ⇥ complete · ⏎ run</Text>
        </Box>
      ) : null}
      <Box borderStyle="round" borderColor={border} borderDimColor={!live} paddingX={1} flexDirection="column">
        {value ? (
          vRows.slice(win.start, win.end).map((line, i) => {
            const abs = win.start + i
            const isCursorRow = abs === cRow
            const isLastVisible = i === win.end - win.start - 1
            // The line body is composed as ONE string with the cursor as raw
            // ANSI inverse (same approach as Transcript's pre-rendered
            // markdown lines) — nested <Text> runs inside a flex row get
            // fragmented widths from Yoga and wrap into vertical rubble.
            const body = isCursorRow
              ? line.slice(0, cCol) + "\x1b[7m" + (line[cCol] ?? " ") + "\x1b[27m" + line.slice(cCol + 1)
              : line || " "
            const trailer = isLastVisible
              ? (modeHint ? `  ${modeHint}` : "") +
                (hist.current.index !== -1 ? `  ⟲ ${hist.current.index + 1}/${hist.current.entries.length}` : "") +
                (win.end < vRows.length ? `  ⋮ +${vRows.length - win.end}` : "")
              : ""
            return (
              <Box key={abs}>
                {i === 0 ? (
                  abs === 0 ? (
                    <>
                      {pendingImageCount ? <Text color="cyan">📎 {pendingImageCount} </Text> : null}
                      <Text color={border}>{isSlash ? "/ " : isBang ? "! " : "› "}</Text>
                    </>
                  ) : (
                    // The window has scrolled past the first line.
                    <Text dimColor>{"⋮ "}</Text>
                  )
                ) : (
                  <Text>{"  "}</Text>
                )}
                <Text wrap="truncate-end">{body}</Text>
                {trailer ? (
                  <Text dimColor wrap="truncate-end">
                    {trailer}
                  </Text>
                ) : null}
              </Box>
            )
          })
        ) : (
          <Box>
            {pendingImageCount ? <Text color="cyan">📎 {pendingImageCount} </Text> : null}
            <Text color={border}>{"› "}</Text>
            <Text dimColor>Message the room · / commands · ! shell · ⇧⇥ routing · Ctrl+C quit</Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}
