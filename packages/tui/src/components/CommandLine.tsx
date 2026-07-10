import { Box, Text, useInput } from "ink"
import { useEffect, useState } from "react"
import { matchCommands } from "../commands/registry"
import { shouldAbortOnEscape } from "../escape-behavior"
import { pickerKeyAction, pickerVisible } from "../answer-picker"
import { inputBorderColor, inputMode, inputModeHint } from "../input-mode"
import type { RoutingMode } from "@pipeline-moe/client-core"

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
  isActive: boolean
  connected: boolean
}) {
  const [value, setValue] = useState("")
  const [cursor, setCursor] = useState(0)
  // The input is a single line; a raw \r or \n landing in `value` (multi-line
  // paste via the terminal, or a fast writer whose text+Enter arrives as one
  // stdin chunk so Ink never parses key.return) splits the rendered row and
  // overflows the fixed-height layout — Ink's repaint then shifts rows and the
  // input box appears mangled. Flatten to spaces at every insertion point.
  const flatten = (s: string) => s.replace(/[\r\n]+/g, " ")
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

  if (pasteInsertRef)
    pasteInsertRef.current = (raw) =>
      setValue((v) => {
        const text = flatten(raw)
        const next = v.slice(0, cursor) + text + v.slice(cursor)
        setCursor(cursor + text.length)
        return next
      })

  const isSlash = value.startsWith("/")
  const isBang = value.startsWith("!")
  const head = isSlash ? value.slice(1).split(" ")[0] : ""
  const showPalette = isSlash && !value.includes(" ")
  const matches = showPalette ? matchCommands(head) : []
  const idx = matches.length ? Math.min(pIndex, matches.length - 1) : 0

  const reset = () => {
    setValue("")
    setCursor(0)
    setPIndex(0)
  }

  useInput(
    (input, key) => {
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
        const text = value.trim()
        // A staged image can go out with no text at all (image-only message,
        // mirrors the web UI's Composer) — so an empty line with a pending
        // image is a send, not the "+ room" tab's onEmptyEnter.
        if (text || (pendingImageCount ?? 0) > 0) {
          // While the palette is open, Enter runs the highlighted command
          // (so "/r"⏎ on ▶/resume runs /resume, not the ambiguous "/r").
          if (matches.length > 0) onCommand("/" + matches[idx].name)
          else if (text.startsWith("/")) onCommand(text)
          else if (text.startsWith("!") && onShell) {
            const cmd = text.slice(1).trim()
            if (cmd) onShell(cmd)
          } else onSend(text)
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
        const next = "/" + matches[idx].name + " "
        setValue(next)
        setCursor(next.length)
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
      // Outside the palette, ↑/↓ scroll the transcript — this is also what the
      // mouse wheel emits in the alt screen (alternate-scroll mode 1007).
      // Ctrl+↑/↓ is left alone here — Transcript's own useInput claims that
      // combo to jump to the very top/bottom (see the final ctrl/meta/tab
      // catch-all below, which swallows it before it can insert text).
      if (key.upArrow && !key.ctrl) {
        onScroll?.(1)
        return
      }
      if (key.downArrow && !key.ctrl) {
        onScroll?.(-1)
        return
      }
      if (key.leftArrow) {
        if (!value && onRoomNav) return onRoomNav(-1)
        setCursor((c) => Math.max(0, c - 1))
        return
      }
      if (key.rightArrow) {
        if (!value && onRoomNav) return onRoomNav(1)
        setCursor((c) => Math.min(value.length, c + 1))
        return
      }
      if (key.ctrl && input === "a") {
        setCursor(0)
        return
      }
      if (key.ctrl && input === "e") {
        setCursor(value.length)
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
        if (cursor > 0) {
          setValue((v) => v.slice(0, cursor - 1) + v.slice(cursor))
          setCursor((c) => c - 1)
        }
        return
      }
      if (key.delete) {
        // Some terminals map Backspace to the Delete key; treat it as backspace
        // when there's nothing to the right, otherwise as a forward delete.
        if (cursor < value.length) {
          setValue((v) => v.slice(0, cursor) + v.slice(cursor + 1))
        } else if (cursor > 0) {
          setValue((v) => v.slice(0, cursor - 1))
          setCursor((c) => c - 1)
        }
        return
      }
      if (key.ctrl || key.meta || key.tab) return
      if (input) {
        const text = flatten(input)
        setValue((v) => v.slice(0, cursor) + text + v.slice(cursor))
        setCursor((c) => c + text.length)
      }
    },
    { isActive },
  )

  // The visible text drops the leading "/" or "!" (shown as a colored prompt
  // glyph), so the cursor maps one slot left in slash/bang mode.
  const disp = isSlash || isBang ? value.slice(1) : value
  const dcur = isSlash || isBang ? Math.max(0, cursor - 1) : cursor
  const before = disp.slice(0, dcur)
  const atChar = disp[dcur] ?? " "
  const after = disp.slice(dcur + 1)

  // The border speaks the mode: "/" yellow, "!" red, plain text follows the
  // routing mode (cyan auto / blue semi / gray manual). Dead input dims.
  const mode = inputMode(value)
  const live = isActive && connected
  const border = inputBorderColor(mode, routingMode ?? "auto", live)
  // Name the mode while its command part is still empty — the bare glyph
  // ("! ") gave no feedback that the input switched semantics.
  const modeHint = disp.length === 0 && value ? inputModeHint(mode) : null

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
          {matches.map((c, i) => (
            <Box key={c.name} justifyContent="space-between">
              <Text color={i === idx ? "yellow" : undefined} inverse={i === idx}>
                {i === idx ? "▶ " : "  "}/{c.name}
                {c.usage ? <Text dimColor> {c.usage}</Text> : null}
              </Text>
              <Text dimColor> {c.summary}</Text>
            </Box>
          ))}
          <Text dimColor>↑↓ select · ⇥ complete · ⏎ run</Text>
        </Box>
      ) : null}
      <Box borderStyle="round" borderColor={border} borderDimColor={!live} paddingX={1}>
        {pendingImageCount ? <Text color="cyan">📎 {pendingImageCount} </Text> : null}
        <Text color={border}>{isSlash ? "/ " : isBang ? "! " : "› "}</Text>
        {value ? (
          <Text>
            {before}
            <Text inverse>{atChar}</Text>
            {after}
            {modeHint ? (
              <Text color={border} dimColor>
                {"  "}
                {modeHint}
              </Text>
            ) : null}
          </Text>
        ) : (
          <Text dimColor>Message the room · / commands · ! shell · ⇧⇥ routing · Ctrl+C quit</Text>
        )}
      </Box>
    </Box>
  )
}
