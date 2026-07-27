#!/usr/bin/env -S npx tsx
// pmoe-next — the pipeline-moe terminal client on @earendil-works/pi-tui.
//
//   pmoe-next [--server http://localhost:5300] [--room default] [--stats]
//
// This is the second client, growing beside the Ink one (`src/`) on the same
// @pipeline-moe/client-core. Both are shipped; `pmoe` stays the default until
// this one reaches parity. See docs/tui-pitui-migration-plan.md for the phase
// order and the five gates every phase must re-pass.
//
// Phase 5 status: FEATURE PARITY. Transcript, chrome, input, all eleven overlay
// kinds, the QCM answer picker, the OAuth panel, ⌃V image staging, room switching
// with the tab strip — and one thing the Ink client cannot do at all: images
// actually render, inline, on a terminal with the kitty or iTerm2 graphics
// protocol, both in the transcript and as a preview of what ⌃V just staged.
//
// The one thing this client does NOT have, by design: scroll state. No offset,
// no maxOffset, no PgUp/PgDn, no reservedRows arithmetic, no bodyHeight. The
// conversation grows into the terminal's OWN scrollback, so the wheel, text
// selection and terminal search are the terminal's — not a re-implementation.

import { spawn } from "node:child_process"
import {
  TUI,
  ProcessTerminal,
  Editor,
  KeybindingsManager,
  Text,
  TUI_KEYBINDINGS,
  setKeybindings,
  truncateToWidth,
  matchesKey,
  type Component,
} from "@earendil-works/pi-tui"
import chalk from "chalk"
import { createApi, createRoomStore, preloadRoomState, previewRouting } from "@pipeline-moe/client-core"
import type { RoomState, RoomStore, RoomSummary } from "@pipeline-moe/client-core"
import { nodeEventSourceFactory } from "../nodeEventSource"
import { readClipboardImage, readClipboardText } from "../clipboard-image"
import { transcriptLines, paint } from "../transcript-lines"
import { chromeLines } from "../chrome-lines"
import { inputBorderColor, inputMode } from "../input-mode"
import { AnswerPickerComponent } from "./answers"
import { PmoeAutocompleteProvider } from "./autocomplete"
import { createCommandRunner } from "./commands"
import { ImageStrip } from "./images"
import { OAuthPanelComponent } from "./oauth"
import { OverlayHost } from "./overlay-host"
import { nextRoomSlot } from "./rooms"
import { createShellRunner, resumeBelow } from "./shell"
import { classifySubmit, nextRoutingMode } from "./submit"

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const apiBase = arg("--server", process.env.PMOE_SERVER ?? "http://localhost:5300")
const initialRoomId = arg("--room", "default")
const showStats = process.argv.includes("--stats")

/* ── The transcript ─────────────────────────────────────────────────────────
 *
 * It returns the WHOLE conversation every frame and lets the TUI diff the
 * array: only the lines that changed are rewritten, and everything above the
 * viewport is inert by construction (`firstChanged < prevViewportTop` is the
 * only path that would touch it, and finalized lines never change).
 */
class TranscriptComponent implements Component {
  // The collapsed tool line prints "· ctrl+o" and the fold hint prints "⌃T" —
  // promises the transcript makes on screen, so this client has to keep them.
  showThoughts = true
  showTools = false
  hasThoughts = false

  constructor(
    private getState: () => RoomState,
    private images: ImageStrip,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const state = this.getState()
    const w = Math.max(20, width - 2)
    const { lines, hasThoughts } = transcriptLines(
      {
        messages: state.messages,
        roster: state.roster,
        streaming: state.streaming,
        liveReasoning: state.liveReasoning,
        liveActivity: state.liveActivity,
        liveParts: state.liveParts,
        reasoningActive: state.reasoningActive,
        receipts: state.receipts,
      },
      w,
      { showThoughts: this.showThoughts, showTools: this.showTools },
    )
    this.hasThoughts = hasThoughts
    const out: string[] = []
    for (const l of lines) {
      // An attachment line becomes the image itself when the terminal can draw
      // it. These rows leave `images.ts` ready to print: no indent, no
      // truncation — a prefix inside a graphics sequence corrupts the payload,
      // and pi-tui exempts image lines from the width check for the same reason.
      if (l.images?.length) {
        const rows = this.images.lines(l.images, w)
        if (rows) {
          out.push(...rows)
          continue
        }
      }
      // pi-tui THROWS if a rendered line exceeds the width — the invariant the
      // Ink layer enforces silently with wrap="truncate-end". Same rule, but a
      // hard error instead of a cropped table nobody notices.
      out.push(" " + truncateToWidth(paint(l) + (l.cursor ? chalk.yellow(" ▌") : ""), w))
    }
    return out
  }
}

/** The chrome — tabs, roster strip, tasks, notices, status bar — all BELOW the
 *  conversation, which is the migration's one load-bearing layout constraint
 *  (see chrome-lines.ts for the measurement that forced it).
 *
 *  Nothing here is windowed or budgeted. The Ink client had to book every one of
 *  these rows in `reservedRows` and subtract them from the transcript's height,
 *  because overflowing the frame corrupted Ink's row diffing. Here the chrome
 *  simply occupies the lines after the transcript and may change height freely. */
class ChromeComponent implements Component {
  rooms: RoomSummary[] = []
  plusSelected = false
  draftTargets: { t: string[]; d: string[] } | null = null

  constructor(
    private getState: () => RoomState,
    private roomId: () => string,
    private connection: () => "connecting" | "connected" | "reconnecting",
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const s = this.getState()
    const roomId = this.roomId()
    return chromeLines(
      {
        roomId,
        rooms: this.rooms.length > 0 ? this.rooms : [{ roomId, name: roomId, goalStatus: "idle" } as RoomSummary],
        plusSelected: this.plusSelected,
        conversationTitle: s.conversations?.find((c) => c.id === s.currentConversationId)?.title,
        roster: s.roster,
        runningAgentId: s.runningAgentId,
        defaultModel: s.defaultModel,
        tasks: s.tasks,
        notices: s.notices,
        connection: this.connection(),
        turnActive: s.turnActive,
        runningSince: s.runningSince,
        paused: s.paused,
        pausedAskerId: s.pausedAskerId,
        routingMode: s.routingMode,
        messageCount: s.messages.length,
        drift: s.drift,
        roomUsage: s.roomUsage,
        draftTargets: this.draftTargets,
      },
      width,
    ) // already fitted to the width — chrome-lines.ts owns that invariant
  }
}

/** Staged attachments, above the input. ⌃V does not SEND an image — it stages it,
 *  the same contract as the web Composer, so a message and its screenshot go
 *  together. And because this client can draw, the staged image is shown as the
 *  image: the one place where "did I paste the right screenshot?" has an answer
 *  before you hit ⏎. */
class PendingImagesComponent implements Component {
  images: string[] = []

  constructor(private strip: ImageStrip) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (this.images.length === 0) return []
    const w = Math.max(20, width - 2)
    const label = chalk.dim(
      `  📎 ${this.images.length} image${this.images.length === 1 ? "" : "s"} staged · ⏎ sends them with your message · esc clears`,
    )
    const rows = this.strip.lines(this.images, w)
    return rows ? [...rows, label] : [label]
  }
}

/** Stats line — the point of the migration made visible while you use it.
 *  `fullRedraws` is pi-tui's own counter: every increment is a frame that had
 *  to clear the screen AND the scrollback. Gate 1 of every phase is that it
 *  stays at 1 (the first render) through an entire streaming turn. */
class StatsComponent implements Component {
  constructor(
    private tui: TUI,
    private bytes: () => number,
    private frames: () => number,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (!showStats) return []
    const kb = (this.bytes() / 1024).toFixed(1)
    const f = this.frames()
    const perFrame = f > 0 ? Math.round(this.bytes() / f) : 0
    return [
      truncateToWidth(
        chalk.dim(`⟨ frames ${f} · ${kb} KiB written · ${perFrame} B/frame · full redraws ${this.tui.fullRedraws} ⟩`),
        width,
      ),
    ]
  }
}

async function main(): Promise<void> {
  // ── The room, and the store bound to it ──────────────────────────────────
  //
  // A store is bound to ONE room at construction (the web client works the same
  // way), so switching rooms means building a new one and disposing the old. That
  // is why nothing here captures `store`: every reader goes through `getState()`
  // or `currentStore()`, which read the live binding at call time. A callback that
  // closed over the store would keep pushing notices into a disposed room.
  let roomId = initialRoomId
  const initialState = await preloadRoomState(apiBase, roomId).catch(() => undefined)
  let store = createRoomStore({
    apiBase,
    roomId,
    eventSourceFactory: nodeEventSourceFactory,
    ...(initialState ? { initialState } : {}),
  })
  const currentStore = (): RoomStore => store
  const getState = (): RoomState => store.getSnapshot()

  const terminal = new ProcessTerminal()
  // Count what actually reaches the terminal — the number that decides whether
  // a phase regressed. Ink's write path erases and rewrites the whole frame on
  // every token (log-update.js: `eraseLines(previousLineCount) + output`).
  let bytes = 0
  let frames = 0
  const rawWrite = terminal.write.bind(terminal)
  terminal.write = (data: string): void => {
    bytes += Buffer.byteLength(data)
    frames += 1
    rawWrite(data)
  }

  const tui = new TUI(terminal, true)

  // The store only exposes a `connected` boolean, but the EventSource keeps
  // retrying after a drop — so "was connected, isn't now" means reconnecting,
  // not merely offline.
  let everConnected = false
  let connection: "connecting" | "connected" | "reconnecting" = "connecting"

  // Layout order is LOAD-BEARING, and it is the migration's sharpest finding.
  // Mutating chrome ABOVE the transcript sits at a line index that never grows,
  // so every roster change rewrites a line that scrolled above the viewport
  // long ago — and pi-tui answers that with a full redraw that clears the
  // scrollback (`firstChanged < prevViewportTop`). Measured: header on top → a
  // full redraw per turn; header below → one, ever.
  const images = new ImageStrip({ apiBase, requestRender: () => tui.requestRender() })
  const transcript = new TranscriptComponent(getState, images)
  tui.addChild(transcript)
  const chrome = new ChromeComponent(getState, () => roomId, () => connection)
  tui.addChild(chrome)
  tui.addChild(new StatsComponent(tui, () => bytes, () => frames))

  // The room list feeds the tab strip. Rooms appear and disappear outside this
  // client's control (the web UI, Planner's spawn_room), so it is refreshed on
  // connect and on every switch, with a slow poll as the catch-all.
  const refreshRooms = (): Promise<void> =>
    api
      .listRooms()
      .then((rs) => {
        chrome.rooms = rs
        tui.requestRender()
      })
      .catch(() => {})

  // Alt+⏎ is the multiline gesture this client's users already have in their
  // fingers, and pi-tui does not bind it (shift+enter / ctrl+j). Add it rather
  // than replace: a terminal that swallows one chord still has the others, which
  // is the whole reason our Ink version also accepted a trailing "\" — and the
  // Editor already implements that one (`shouldSubmitOnBackslashEnter`).
  setKeybindings(
    new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.input.newLine": ["alt+enter", "shift+enter", "ctrl+j"],
    }),
  )

  // The input's ─── borders speak the mode, same contract as the Ink client
  // (input-mode.ts): "/" yellow, "!" red, plain text follows the routing mode
  // (cyan auto / blue semi / gray manual / magenta supervised), and a dead
  // input — unfocused or disconnected — dims regardless. The Editor calls its
  // theme's `borderColor` on every render, so a closure over the live state is
  // all it takes; the color names come from the same shared table the Ink
  // border and the status bar's routing segment read.
  const BORDER_CHALK: Record<string, (s: string) => string> = {
    yellow: chalk.yellow,
    red: chalk.red,
    cyan: chalk.cyan,
    blue: chalk.blue,
    gray: chalk.gray,
    magenta: chalk.magenta,
  }
  const editor = new Editor(tui, {
    borderColor: (s: string) => {
      const live = editor.focused && connection === "connected"
      if (!live) return chalk.dim(s)
      const c = inputBorderColor(inputMode(editor.getText()), getState().routingMode ?? "auto", true)
      return (BORDER_CHALK[c] ?? chalk.dim)(s)
    },
    selectList: {
      selectedPrefix: (s: string) => chalk.cyan(s),
      selectedText: (s: string) => chalk.cyan(s),
      description: (s: string) => chalk.dim(s),
      scrollInfo: (s: string) => chalk.dim(s),
      noMatch: (s: string) => chalk.dim(s),
    },
  })

  const { api } = createApi(apiBase)

  /** Hand the terminal to a blocking child process and take it back — `/prompt`'s
   *  $EDITOR, the same gesture `!` already makes. pi-tui documents stop/start as
   *  the suspend path (its `terminal.start()` even re-fires SIGWINCH, because the
   *  window may have been resized while the child owned the screen), and
   *  `resumeBelow` is what keeps the cost at ZERO full redraws: forget the frame,
   *  keep the dimensions, re-print below whatever the child left. */
  const suspend = (run: () => void): void => {
    tui.stop()
    try {
      run()
    } finally {
      tui.start()
      resumeBelow(tui)
    }
  }

  // ── Room switching ───────────────────────────────────────────────────────
  //
  // Hydrate-then-swap: the CURRENT room stays on screen while the next one's
  // state is fetched (~one local round-trip), so the first frame of the new room
  // is already complete and nothing flashes empty. The monotonic token is there
  // because holding ← fires overlapping preloads and only the NEWEST may land —
  // an older fetch resolving late must not yank the user back.
  let switchSeq = 0
  // A notice pushed in the same tick as a switch would land on the store being
  // disposed. Park it, and let whichever store is live next deliver it — with a
  // deadline, because `notifyAfterSwitch` is also called by commands that end up
  // NOT switching, and a notice that never appears is worse than a late one.
  let parked: string | null = null
  const flushParked = (): void => {
    if (!parked) return
    store.pushNotice(parked)
    parked = null
    tui.requestRender()
  }
  const notifyAfterSwitch = (message: string): void => {
    parked = message
    setTimeout(flushParked, 1500).unref()
  }

  const swap = (id: string, initial: Partial<RoomState> | undefined): void => {
    // Overlays belong to the room they were opened from: a line-up editor still
    // holding the previous roster would apply its next keystroke to a room the
    // user has left.
    overlays.closeAll()
    store.stop()
    unsubscribe()
    roomId = id
    store = createRoomStore({
      apiBase,
      roomId: id,
      eventSourceFactory: nodeEventSourceFactory,
      ...(initial ? { initialState: initial } : {}),
    })
    everConnected = false
    connection = "connecting"
    unsubscribe = store.subscribe(onStoreChange)
    store.start()
    flushParked()
    void refreshRooms()
    tui.requestRender()
  }

  const switchRoom = (id: string): void => {
    chrome.plusSelected = false
    if (id === roomId) return
    const seq = ++switchSeq
    preloadRoomState(apiBase, id)
      .then((initial) => {
        if (switchSeq === seq) swap(id, initial)
      })
      // On a failed preload, swap anyway: the store's own loadSnapshot is the
      // recovery path, and refusing to switch leaves the user in the room they
      // asked to leave.
      .catch(() => {
        if (switchSeq === seq) swap(id, undefined)
      })
  }

  /** ←/→ cycle over [room0…roomN, +]. Landing on the trailing slot selects it
   *  rather than switching — it is a cursor position, not a room. */
  const roomNav = (dir: -1 | 1): void => {
    const slot = nextRoomSlot(chrome.rooms.map((r) => r.roomId), roomId, chrome.plusSelected, dir)
    if (slot.kind === "plus") {
      chrome.plusSelected = true
      tui.requestRender()
      return
    }
    switchRoom(slot.roomId)
  }

  /** ⏎ on the + tab: create a new room, or resume a closed one (the web UI's
   *  resumable-rooms list). Straight to the create form when there is nothing to
   *  resume, or when the list cannot be fetched. */
  const openRoomEntry = (): void => {
    api
      .resumableRooms()
      .then((list) => {
        if (list.length === 0) {
          overlays.open({ kind: "roomForm" })
          return
        }
        overlays.open({
          kind: "select",
          title: "Room…",
          items: [
            { id: "", label: "＋ Create new room" },
            ...list.map((r) => ({
              id: r.roomId,
              label: `↻ ${r.name}`,
              hint:
                `${r.messageCount} msg${r.messageCount === 1 ? "" : "s"}` +
                (r.lastActivity ? ` · ${new Date(r.lastActivity).toLocaleDateString()}` : ""),
            })),
          ],
          onSelect: (id) => {
            if (!id) {
              overlays.open({ kind: "roomForm" })
              return
            }
            const name = list.find((r) => r.roomId === id)?.name ?? id
            api
              .resumeRoom(id)
              .then(() => {
                notifyAfterSwitch(`Room "${name}" resumed.`)
                switchRoom(id)
              })
              .catch((err: unknown) =>
                store.pushNotice(
                  err instanceof Error && err.message ? err.message : "Resume failed — server unreachable?",
                  "error",
                ),
              )
          },
        })
      })
      .catch(() => overlays.open({ kind: "roomForm" }))
  }

  // The host is built before the runner it calls into, so the callback is late-
  // bound: /lineup's `a` raises /agent, which is a registry command.
  const overlays = new OverlayHost({
    tui,
    store: currentStore,
    api,
    suspend,
    refocus: () => tui.setFocus(editor),
    runCommand: (input) => runCommand(input),
    onRoomCreated: (id, name, hadGoal) => {
      notifyAfterSwitch(`Created room "${name}"${hadGoal ? " — goal started." : "."}`)
      switchRoom(id)
    },
  })
  const runCommand = createCommandRunner({
    store: currentStore,
    api,
    getState,
    openOverlay: (o) => overlays.open(o),
    closeOverlay: () => overlays.close(),
    switchRoom,
    notifyAfterSwitch,
  })
  const runShell = createShellRunner({
    tui,
    store: currentStore,
    workspaceDir: () => chrome.rooms.find((r) => r.roomId === roomId)?.workspaceDir,
    refocus: () => tui.setFocus(editor),
  })

  // The palette and @mention completion. The Editor owns trigger detection,
  // debouncing and the dropdown; the provider is a pure function of the draft.
  editor.setAutocompleteProvider(new PmoeAutocompleteProvider(() => getState().roster))

  // THE PASTE-DISPATCH GUARD (session mrff3qwe: a pasted report routed @builder
  // and @tester). It rests on one thing — that the preview and the send agree on
  // exactly which string routes — and `getExpandedText()` is what makes that
  // true here: a paste marker hides @mentions, and the preview must show what
  // send will actually dispatch. Their Editor also closes the other half of the
  // hazard for free: bracketed paste is buffered until the end marker, so a
  // newline inside a paste can no longer be read as ⏎.
  editor.onChange = (): void => {
    const s = getState()
    const text = editor.getExpandedText()
    const p =
      !text.startsWith("/") && !text.startsWith("!") && text.trim() && s.roster.length > 0
        ? previewRouting(text, s.roster, s.defaultAgent ?? null)
        : null
    chrome.draftTargets = p && (p.kind === "mentions" || p.kind === "all") ? { t: p.targetIds, d: p.dropped } : null
    tui.requestRender()
  }

  // The submitted text arrives as the ARGUMENT, already paste-expanded, and the
  // Editor has ALREADY reset itself — state, paste store and undo stack — before
  // calling this (components/editor.js: submitValue). That is the opposite
  // contract from our Ink CommandLine, which read its own state at submit time,
  // and reading the editor back here is silently empty rather than an error: it
  // cost every slash command a no-op until it was caught live.
  //
  // It also decides what history stores. Ink kept the line as TYPED, markers
  // included, because its paste store outlived the send. This one's does not, so
  // a marker in history could never expand again — history gets the expanded
  // text, and recalling a large paste recalls the paste.
  editor.onSubmit = (expanded: string): void => {
    const sub = classifySubmit(expanded)
    const staged = pending.images
    // An empty line with something staged is still a send — that is how you post a
    // screenshot with no words, and the placeholder is what the vision models see
    // as the user turn.
    if (sub.kind === "empty") {
      if (staged.length > 0) {
        store.actions.send("(image shared)", staged)
        pending.images = []
        tui.requestRender()
      }
      return
    }
    chrome.draftTargets = null
    editor.addToHistory(expanded)
    switch (sub.kind) {
      case "noop":
        break
      case "command":
        if (sub.input === "/quit" || sub.input === "/exit") {
          tui.stop()
          store.stop()
          process.exit(0)
        }
        runCommand(sub.input)
        break
      case "shell":
        runShell(sub.command)
        break
      case "send":
        store.actions.send(sub.text, staged.length > 0 ? staged : undefined)
        pending.images = []
        break
    }
  }

  /** ⌃V. An image stages; anything else pastes as text at the cursor. */
  const pasteClipboard = async (): Promise<void> => {
    try {
      const img = await readClipboardImage()
      if (img.ok) {
        pending.images = [...pending.images, img.dataUri]
        store.pushNotice("📎 Image staged — write your message and press ⏎ to send.")
        tui.requestRender()
        return
      }
      if (img.reason !== "no-image") {
        store.pushNotice(img.error, "error")
        return
      }
      const txt = await readClipboardText()
      if (txt.ok && txt.text) {
        editor.insertTextAtCursor(txt.text)
        tui.requestRender()
      }
    } catch (err: unknown) {
      store.pushNotice(err instanceof Error && err.message ? err.message : "Clipboard paste failed.", "error")
    }
  }

  // The QCM picker sits directly above the input, where the Ink one did — but as
  // rows, not as a booked height. See answers.ts.
  const answers = new AnswerPickerComponent({
    // Only while the room is actually paused on a question: stale options from a
    // question already answered would offer choices the server no longer accepts.
    options: () => (getState().paused ? getState().pausedOptions ?? null : null),
    askerId: () => getState().pausedAskerId ?? null,
    draft: () => editor.getText(),
    onAnswer: (text) => {
      store.actions.send(text)
      tui.requestRender()
    },
    requestRender: () => tui.requestRender(),
  })
  tui.addChild(answers)
  const pending = new PendingImagesComponent(images)
  tui.addChild(pending)
  tui.addChild(editor)
  tui.addChild(
    new Text(
      chalk.dim("  /help · ⌃O tools · ⌃T thoughts · ⌃P tasks · ⌃R roster · ⇧⇥ routing · scroll with your terminal"),
    ),
  )
  tui.setFocus(editor)

  // ⌃O / ⌃T / ⌃P / ⌃R / ⇧⇥ / Esc, the QCM picker, and ←/→ room navigation. An
  // input listener runs BEFORE the focused component, so the Editor never sees
  // these — the same arbitration Ink gave us for free by having CommandLine
  // ignore ctrl-chords.
  //
  // An OPEN OVERLAY owns the keyboard first. Every chord below would otherwise
  // fire straight through a modal: ⌃T while a picker is up would fold the
  // thoughts behind it, and ⇧⇥ would cycle routing from inside an API-key prompt.
  // The one exception is ⌃P, which closes the task board it opened — a toggle has
  // to work in both directions or it is a trap.
  tui.addInputListener((data: string) => {
    if (overlays.isOpen()) {
      if (matchesKey(data, "ctrl+p")) return undefined // the board handles its own close
      if (matchesKey(data, "escape")) return undefined // so does every overlay's cancel
      if (matchesKey(data, "ctrl+o") || matchesKey(data, "ctrl+t") || matchesKey(data, "shift+tab")) {
        return { consume: true }
      }
      return undefined
    }
    // The picker owns ↑↓/⏎/digits/esc while it is visible, and only then — the
    // same precedent as the slash palette owning ↑↓ while open. Anything it does
    // not claim falls through: typing IS the free-text answer.
    if (answers.handleKey(data)) return { consume: true }
    if (matchesKey(data, "ctrl+p")) {
      runCommand("/tasks")
      return { consume: true }
    }
    if (matchesKey(data, "ctrl+r")) {
      runCommand("/roster")
      return { consume: true }
    }
    if (matchesKey(data, "ctrl+o")) {
      transcript.showTools = !transcript.showTools
      tui.requestRender()
      return { consume: true }
    }
    if (matchesKey(data, "ctrl+t")) {
      transcript.showThoughts = !transcript.showThoughts
      tui.requestRender()
      return { consume: true }
    }
    if (matchesKey(data, "shift+tab")) {
      const next = nextRoutingMode(getState().routingMode)
      store.actions.setRoutingMode(next)
      store.pushNotice(`Routing mode → ${next}.`)
      return { consume: true }
    }
    // ⌃V: an image on the clipboard is STAGED, not sent (the web Composer's
    // contract). Anything else falls back to a plain text paste at the cursor —
    // ⌃V is not a terminal paste gesture, which is why this exists at all. pi-tui
    // binds nothing to it, so there is no chord to arbitrate with.
    if (matchesKey(data, "ctrl+v")) {
      void pasteClipboard()
      return { consume: true }
    }
    // ←/→ cycle rooms on an EMPTY line only: the arrows keep their cursor role
    // the moment there is a draft, and the autocomplete keeps them while it is
    // open. ⏎ on the + tab is the create/resume entry point.
    if (!editor.getText() && !editor.isShowingAutocomplete()) {
      if (matchesKey(data, "left")) {
        roomNav(-1)
        return { consume: true }
      }
      if (matchesKey(data, "right")) {
        roomNav(1)
        return { consume: true }
      }
      if (matchesKey(data, "enter") && chrome.plusSelected) {
        openRoomEntry()
        return { consume: true }
      }
    }
    // Esc aborts a running turn — but only when there is nothing nearer for it
    // to close. The Editor uses Esc to dismiss its autocomplete; stealing it here
    // would make the dropdown unclosable. (Overlays are handled above.)
    if (matchesKey(data, "escape")) {
      if (editor.isShowingAutocomplete() || tui.hasOverlay()) return undefined
      // Staged images go before the draft does: they are the thing most easily
      // staged by accident, and clearing the text first would leave them hanging.
      if (pending.images.length > 0) {
        pending.images = []
        tui.requestRender()
        return { consume: true }
      }
      if (editor.getText()) {
        editor.setText("")
        chrome.draftTargets = null
        tui.requestRender()
        return { consume: true }
      }
      if (getState().turnActive) {
        runCommand("/abort")
        return { consume: true }
      }
    }
    return undefined
  })

  // ── The OAuth panel ─────────────────────────────────────────────────────
  //
  // A flow starts asynchronously (the server broadcasts progress after /login),
  // so the panel is raised and dropped by the store, not by a command: an overlay
  // layer while `oauthProgress` is set, gone when it clears. See oauth.ts for why
  // it takes focus even over an open overlay.
  let oauthLayer: (() => void) | null = null
  let openedAuthUrl: string | null = null
  const syncOAuth = (): void => {
    const p = getState().oauthProgress ?? null
    if (p && !oauthLayer) {
      oauthLayer = overlays.pushComponent(
        new OAuthPanelComponent({
          progress: () => getState().oauthProgress ?? null,
          onDismiss: () => store.actions.dismissOAuth(),
          onSubmitInput: (value) => {
            const cur = getState().oauthProgress
            if (cur) store.actions.submitOAuthInput(cur.provider, value)
          },
        }),
      )
    } else if (!p && oauthLayer) {
      oauthLayer()
      oauthLayer = null
      openedAuthUrl = null
    }
    // Open the authorization URL in the LOCAL browser as soon as it arrives — the
    // client runs where the user is, the server may be headless. Best effort: the
    // panel shows the URL either way, and once per URL so a redraw cannot spawn a
    // second tab.
    const url = p?.status === "auth_url" ? p.url : undefined
    if (url && url !== openedAuthUrl) {
      openedAuthUrl = url
      try {
        spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" })
          .on("error", () => {})
          .unref()
      } catch {}
    }
  }

  const onStoreChange = (): void => {
    const s = getState()
    if (s.connected) {
      if (!everConnected) void refreshRooms()
      everConnected = true
    }
    connection = s.connected ? "connected" : everConnected ? "reconnecting" : "connecting"
    syncOAuth()
    tui.requestRender()
  }
  let unsubscribe = store.subscribe(onStoreChange)
  store.start()
  void refreshRooms()
  // Rooms come and go without this client's involvement (the web UI, a Planner
  // spawn_room). The Ink client polls every 15s for exactly that; so does this.
  setInterval(() => void refreshRooms(), 15_000).unref()

  // The elapsed counter in the status bar. One line, below the conversation, so
  // a tick costs a single line's worth of writes and never touches history —
  // which is exactly why the Ink client had to isolate this tick in its own
  // component to stop it re-rendering the whole app once a second.
  setInterval(() => {
    if (getState().turnActive) tui.requestRender()
  }, 1000).unref()

  tui.start()
  // The store drives renders; nothing polls.
  await new Promise(() => {})
}

void main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
