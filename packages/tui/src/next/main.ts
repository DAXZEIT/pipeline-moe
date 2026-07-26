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
// Phase 2 status: transcript, the full chrome, and the input — pi-tui's Editor
// with multiline, history, kill-ring, undo, paste markers, the slash-command
// palette, @mention completion with a routing preview, and `!` shell. Not yet
// ported: overlays and the forms behind them (phases 3-4), the graph, the prompt
// pager, OAuth, images and room switching (phase 5).
//
// The one thing this client does NOT have, by design: scroll state. No offset,
// no maxOffset, no PgUp/PgDn, no reservedRows arithmetic, no bodyHeight. The
// conversation grows into the terminal's OWN scrollback, so the wheel, text
// selection and terminal search are the terminal's — not a re-implementation.

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
import type { RoomState, RoomSummary } from "@pipeline-moe/client-core"
import { nodeEventSourceFactory } from "../nodeEventSource"
import { transcriptLines, paint } from "../transcript-lines"
import { chromeLines } from "../chrome-lines"
import { PmoeAutocompleteProvider } from "./autocomplete"
import { createCommandRunner } from "./commands"
import { createShellRunner } from "./shell"
import { classifySubmit, nextRoutingMode } from "./submit"

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const apiBase = arg("--server", process.env.PMOE_SERVER ?? "http://localhost:5300")
const roomId = arg("--room", "default")
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

  constructor(private getState: () => RoomState) {}

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
    // pi-tui THROWS if a rendered line exceeds the width — the invariant the
    // Ink layer enforces silently with wrap="truncate-end". Same rule, but a
    // hard error instead of a cropped table nobody notices.
    return lines.map((l) => " " + truncateToWidth(paint(l) + (l.cursor ? chalk.yellow(" ▌") : ""), w))
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
    private connection: () => "connecting" | "connected" | "reconnecting",
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const s = this.getState()
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
  const initialState = await preloadRoomState(apiBase, roomId).catch(() => undefined)
  const store = createRoomStore({
    apiBase,
    roomId,
    eventSourceFactory: nodeEventSourceFactory,
    ...(initialState ? { initialState } : {}),
  })

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
  const getState = (): RoomState => store.getSnapshot()

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
  const transcript = new TranscriptComponent(getState)
  tui.addChild(transcript)
  const chrome = new ChromeComponent(getState, () => connection)
  tui.addChild(chrome)
  tui.addChild(new StatsComponent(tui, () => bytes, () => frames))

  // The room list feeds the tab strip. Fetched once; Phase 5 wires ←→ switching
  // and the "+ room" form, which is what would make it change.
  void fetch(`${apiBase}/api/rooms`)
    .then((r) => r.json() as Promise<RoomSummary[]>)
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

  const editor = new Editor(tui, {
    borderColor: (s: string) => chalk.dim(s),
    selectList: {
      selectedPrefix: (s: string) => chalk.cyan(s),
      selectedText: (s: string) => chalk.cyan(s),
      description: (s: string) => chalk.dim(s),
      scrollInfo: (s: string) => chalk.dim(s),
      noMatch: (s: string) => chalk.dim(s),
    },
  })

  const { api } = createApi(apiBase)
  const runCommand = createCommandRunner({ store, api, getState })
  const runShell = createShellRunner({
    tui,
    store,
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
    if (sub.kind === "empty") return
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
        store.actions.send(sub.text)
        break
    }
  }
  tui.addChild(editor)
  tui.addChild(
    new Text(chalk.dim("  /help · ⌃O tools · ⌃T thoughts · ⇧⇥ routing · scroll with your terminal, not with this app")),
  )
  tui.setFocus(editor)

  // ⌃O / ⌃T / ⇧⇥ / Esc. An input listener runs BEFORE the focused component, so
  // the Editor never sees these — the same arbitration Ink gave us for free by
  // having CommandLine ignore ctrl-chords.
  tui.addInputListener((data: string) => {
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
    // Esc aborts a running turn — but only when there is nothing nearer for it
    // to close. The Editor uses Esc to dismiss its autocomplete, and an overlay
    // uses it to cancel; stealing it here would make the dropdown unclosable.
    if (matchesKey(data, "escape")) {
      if (editor.isShowingAutocomplete() || tui.hasOverlay()) return undefined
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

  store.subscribe(() => {
    const s = getState()
    if (s.connected) everConnected = true
    connection = s.connected ? "connected" : everConnected ? "reconnecting" : "connecting"
    tui.requestRender()
  })
  store.start()

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
