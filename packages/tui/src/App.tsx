import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Box, useStdin } from "ink"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RoomStore, Api, RoomState, RoomSummary } from "@pipeline-moe/client-core"
import { useRoomStore } from "./useRoomStore"
import { RosterStrip } from "./components/RosterStrip"
import { RoomTabs } from "./components/RoomTabs"
import { Transcript } from "./components/Transcript"
import { StatusBar } from "./components/StatusBar"
import { CommandLine } from "./components/CommandLine"
import { Notices } from "./components/Notices"
import { OAuthPanel } from "./components/OAuthPanel"
import { SelectOverlay } from "./components/overlays/SelectOverlay"
import { TextInputOverlay } from "./components/overlays/TextInputOverlay"
import { LineupOverlay } from "./components/overlays/LineupOverlay"
import { TasksOverlay } from "./components/overlays/TasksOverlay"
import { TaskSummary } from "./components/TaskSummary"
import { HeaderDivider } from "./components/HeaderDivider"
import { AgentForm } from "./components/overlays/AgentForm"
import { RoomForm } from "./components/overlays/RoomForm"
import { PromptOverlay } from "./components/overlays/PromptOverlay"
import { EditAgentForm } from "./components/overlays/EditAgentForm"
import { PresetPickerOverlay } from "./components/overlays/PresetPickerOverlay"
import { PresetComposerOverlay } from "./components/overlays/PresetComposerOverlay"
import { lookup } from "./commands/registry"
import type { CommandContext, Overlay } from "./commands/types"
import { useTerminalSize } from "./useTerminalSize"
import { pickerRows } from "./answer-picker"
import { stripRowCount } from "./roster-strip"
import { readClipboardImage, readClipboardText } from "./clipboard-image"

/** Strip terminal escape sequences, CR rewrites (progress bars) and `script`
 *  chatter from a PTY capture so the shared transcript gets clean plain text. */
function cleanPtyCapture(raw: string): string {
  const noEsc = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC — titles, hyperlinks
    .replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "") // CSI — colors, cursor moves
    .replace(/\x1b[@-_=>]/g, "") // bare ESC sequences
  return noEsc
    .split("\n")
    .map((l) => l.split("\r").filter(Boolean).pop() ?? "")
    .map((l) => l.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""))
    .filter((l) => !/^Script (?:started|done) on /.test(l))
    .join("\n")
}

export function App({
  makeStore,
  api,
  preloadRoom,
  initialRoomId,
}: {
  makeStore: (roomId: string, initialState?: Partial<RoomState>) => RoomStore
  api: Api
  /** Pre-fetches a room's frame-shaping state (roster/transcript/tasks/
   *  settings) so switchRoom can hydrate the next store BEFORE swapping —
   *  without it a switch flashes an empty room while the snapshot loads. */
  preloadRoom?: (roomId: string) => Promise<Partial<RoomState>>
  initialRoomId: string
}) {
  // The active room. Switching rooms swaps the store entirely (the store is
  // bound to one roomId at construction), mirroring the web's per-room store.
  const [roomId, setRoomId] = useState(initialRoomId)
  // Preloaded state for the room being switched to — parked here by
  // switchRoom just before setRoomId, consumed exactly once by the store
  // memo below.
  const pendingInitialRef = useRef<Partial<RoomState> | undefined>(undefined)
  const store = useMemo(() => {
    const initial = pendingInitialRef.current
    pendingInitialRef.current = undefined
    return makeStore(roomId, initial)
  }, [makeStore, roomId])

  // Load the snapshot + open the SSE stream when the store changes; the cleanup
  // stops the previous room's stream before the next one starts.
  useEffect(() => {
    store.start()
    return () => store.stop()
  }, [store])

  const state = useRoomStore(store)

  // The store only exposes a connected boolean, but the EventSource keeps
  // retrying after a drop — so "was connected, isn't now" means reconnecting,
  // not just offline. Reset when the store (room) changes.
  const [everConnected, setEverConnected] = useState(false)
  useEffect(() => setEverConnected(false), [store])
  useEffect(() => {
    if (state.connected) setEverConnected(true)
  }, [state.connected])
  const connection = state.connected ? "connected" : everConnected ? "reconnecting" : "connecting"

  const runningAgent = state.runningAgentId
    ? state.roster.find((r) => r.id === state.runningAgentId) ?? null
    : null

  // Open the OAuth authorization URL in the local browser as soon as it
  // arrives — the TUI runs where the user is, so this is the right place to
  // launch it (the server may be headless/remote). Best-effort: if it fails,
  // the panel still shows the URL to open manually.
  const oauthUrl = state.oauthProgress?.status === "auth_url" ? state.oauthProgress.url : undefined
  useEffect(() => {
    if (!oauthUrl) return
    const opener = process.platform === "darwin" ? "open" : "xdg-open"
    try {
      spawn(opener, [oauthUrl], { detached: true, stdio: "ignore" }).on("error", () => {}).unref()
    } catch {}
  }, [oauthUrl])

  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const closeOverlay = () => setOverlay(null)
  // The trailing "+ room" tab is a cursor position, not a room — selected via
  // ←/→ like the others; ⏎ on it opens the create-room form.
  const [plusSelected, setPlusSelected] = useState(false)
  // Monotonic switch token: rapid ←/→ fires overlapping preloads, only the
  // NEWEST may land its room (an older fetch resolving late must not yank
  // the user back).
  const switchSeq = useRef(0)
  const switchRoom = (id: string) => {
    setPlusSelected(false)
    if (id === roomId) return
    const seq = ++switchSeq.current
    if (!preloadRoom) {
      setRoomId(id)
      return
    }
    // Hydrate-then-swap: the CURRENT room stays on screen during the fetch
    // (~one local round-trip) and the new room's first frame is already fully
    // drawn — no empty-room flash. On fetch failure, swap anyway; the store's
    // own loadSnapshot is the recovery path.
    preloadRoom(id)
      .then((initial) => {
        if (switchSeq.current !== seq) return
        pendingInitialRef.current = initial
        setRoomId(id)
      })
      .catch(() => {
        if (switchSeq.current !== seq) return
        setRoomId(id)
      })
  }

  // Open-room list for the tab bar. Rooms appear/disappear outside this
  // client's control (the web UI, Planner's spawn_room), so refresh on
  // connect/switch and keep a light poll as the catch-all.
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const refreshRooms = useCallback(() => {
    api.listRooms().then(setRooms).catch(() => {})
  }, [api])
  useEffect(() => {
    refreshRooms()
    const t = setInterval(refreshRooms, 15_000)
    return () => clearInterval(t)
  }, [refreshRooms, store])
  useEffect(() => {
    if (state.connected) refreshRooms()
  }, [state.connected, refreshRooms])

  const roomNav = (dir: -1 | 1) => {
    // Cycle over [room0..roomN, +] — landing on the + slot selects it instead
    // of switching.
    const ids = rooms.map((r) => r.roomId)
    const n = ids.length
    const at = plusSelected ? n : Math.max(ids.indexOf(roomId), 0)
    const next = (at + dir + n + 1) % (n + 1)
    if (next === n) {
      setPlusSelected(true)
      return
    }
    // Through switchRoom, not setRoomId — tab cycling gets the same
    // hydrate-then-swap as every other switch path.
    switchRoom(ids[next])
  }

  // ⏎ on the + tab: offer both paths — create a new room, or resume a closed
  // one (the web UI's resumable-rooms list). Straight to the create form when
  // there is nothing to resume (or the list can't be fetched).
  const openRoomEntry = () => {
    api
      .resumableRooms()
      .then((list) => {
        if (list.length === 0) {
          setOverlay({ kind: "roomForm" })
          return
        }
        setOverlay({
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
              setOverlay({ kind: "roomForm" })
              return
            }
            const name = list.find((r) => r.roomId === id)?.name ?? id
            api
              .resumeRoom(id)
              .then(() => {
                switchRoom(id)
                refreshRooms()
                setPendingNotice(`Room "${name}" resumed.`)
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
      .catch(() => setOverlay({ kind: "roomForm" }))
  }

  const onEmptyEnter = () => {
    if (plusSelected) openRoomEntry()
  }

  const { setRawMode } = useStdin()

  // "!" shell mode. The command runs interactively in THIS terminal — Ink
  // releases raw mode and the child owns the tty through a `script` PTY, so
  // sudo password prompts and full-screen tools work — inside the room's
  // workspace when that directory exists on this host. The capture is then
  // posted to the shared transcript (context for every agent). Falls back to
  // the server-side runner when the workspace isn't local or there's no tty.
  const runShell = (command: string) => {
    const serverSide = (why: string) => {
      store.pushNotice(`$ ${command} — running non-interactively on the server (${why}).`)
      store.actions.runShell(command).catch((err: unknown) =>
        store.pushNotice(
          err instanceof Error && err.message ? err.message : "Shell failed — server unreachable?",
          "error",
        ),
      )
    }
    const ws = rooms.find((r) => r.roomId === roomId)?.workspaceDir
    if (!ws) return serverSide("server didn't report a workspace — restart it if it predates 0.1.11")
    if (!existsSync(ws)) return serverSide("workspace not on this machine")
    if (!process.stdin.isTTY) return serverSide("no tty")
    const cwd = ws

    const dir = mkdtempSync(join(tmpdir(), "pmoe-shell-"))
    const capture = join(dir, "capture")
    setRawMode(false)
    // Belt and suspenders: force cooked mode at the fd level SYNCHRONOUSLY.
    // `script` snapshots the outer tty's termios for the child pty — if it is
    // still raw (icrnl off), Enter stays a literal ^M and `read`/sudo prompts
    // never complete. Node restores the saved cooked termios here.
    try {
      process.stdin.setRawMode(false)
    } catch {}
    // Leave the alt screen for the duration of the command: the user gets
    // their real terminal (prompt output lands in native scrollback, where it
    // belongs) and Ink's frame is safely parked in the alt buffer.
    process.stdout.write(`\x1b[?1049l\n$ ${command}\n`)
    // script -c runs the command through $SHELL — pin it to bash so `!` has
    // the same shell semantics as the server-side runner regardless of the
    // user's login shell (zsh's `read -p` means coprocess, fish differs more).
    const env = { ...process.env, SHELL: "/bin/bash" }
    const res =
      process.platform === "darwin"
        ? spawnSync("script", ["-q", capture, "bash", "-c", command], { stdio: "inherit", cwd, env })
        : spawnSync("script", ["-qefc", command, capture], { stdio: "inherit", cwd, env })
    // Back into the alt screen, wiped — Ink's incremental erase counters know
    // nothing about the foreign output the command just printed.
    process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H")
    try {
      process.stdin.setRawMode(true)
    } catch {}
    setRawMode(true)

    let output = ""
    try {
      output = cleanPtyCapture(readFileSync(capture, "utf8"))
    } catch {}
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}

    if (res.error) return serverSide("no `script` binary on this host")
    // A user interrupt must not read as a failure. Signals map to their 128+n
    // codes, and the pty's "^C" echo catches commands that trap SIGINT and
    // then exit non-zero themselves (ping to an unreachable host, say) —
    // the exit code alone can't distinguish that from a real error.
    const userStopped = res.signal === "SIGINT" || /\^C/.test(output)
    const exit = userStopped
      ? 130
      : res.status ?? (res.signal === "SIGTERM" ? 143 : res.signal ? 1 : 0)

    // The user decides AFTER the run whether the capture becomes shared
    // context — an hour of ping output would otherwise spam every agent's
    // next turn with no way to stop it. ⏎ on the default sends; Esc keeps it
    // private. (The 8KB server-side clip still applies to what is sent.)
    const lineCount = output ? output.split("\n").filter((l) => l.trim()).length : 0
    setOverlay({
      kind: "select",
      title: `Share shell output? — ${lineCount} line${lineCount === 1 ? "" : "s"} captured`,
      items: [
        { id: "send", label: "Send to chat", hint: "shared context for all agents" },
        { id: "keep", label: "Keep private", hint: "nothing posted" },
      ],
      onSelect: (choice) => {
        if (choice !== "send") {
          store.pushNotice(`$ ${command} — output kept private.`)
          return
        }
        store.actions.postShellRecord(command, output, exit).catch((err: unknown) =>
          store.pushNotice(
            err instanceof Error && err.message ? err.message : "Failed to record shell output.",
            "error",
          ),
        )
      },
      onCancel: () => store.pushNotice(`$ ${command} — output kept private.`),
    })
  }

  // ⇧⇥ cycles the routing mode without typing /route. The status bar reflects
  // the change as soon as the server broadcasts the settings.
  const cycleRouting = () => {
    const order = ["auto", "semi", "manual", "supervised"] as const
    const next = order[(order.indexOf(state.routingMode as (typeof order)[number]) + 1) % order.length]
    store.actions.setRoutingMode(next)
    store.pushNotice(`Routing mode → ${next}.`)
  }

  // A notice pushed in the same tick as a room switch would land on the store
  // being disposed — park it and deliver once the new store is mounted.
  const [pendingNotice, setPendingNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!pendingNotice) return
    store.pushNotice(pendingNotice)
    setPendingNotice(null)
  }, [store, pendingNotice])

  const runCommand = (input: string) => {
    const body = input.slice(1) // strip leading "/"
    const sp = body.indexOf(" ")
    const head = sp === -1 ? body : body.slice(0, sp)
    const args = sp === -1 ? "" : body.slice(sp + 1)
    const cmd = lookup(head)
    if (!cmd) {
      store.pushNotice(`Unknown command: /${head}. Try /help.`, "error")
      return
    }
    const ctx: CommandContext = {
      store,
      api,
      state,
      notify: (m, l) => store.pushNotice(m, l),
      notifyAfterSwitch: setPendingNotice,
      switchRoom,
      openOverlay: setOverlay,
      closeOverlay,
    }
    Promise.resolve(cmd.run(ctx, args)).catch(() => {})
  }

  // Pin the whole app just under the terminal height. If the frame ever grows
  // taller than the screen (a tall overlay under a full transcript), Ink can
  // no longer erase the lines that scrolled off — they stay behind as ghost
  // frames. With a fixed-height root, the middle (roster + transcript) is the
  // only flexible region: it shrinks and clips while an overlay is open, and
  // the frame never exceeds the screen. rows-1, not rows: at outputHeight >=
  // rows Ink abandons incremental erase-and-redraw for a full clearTerminal
  // on every frame, which flickers on each keystroke.
  const { rows, columns } = useTerminalSize()

  // Bridge from CommandLine's ↑/↓ (which is what the mouse wheel sends in the
  // alt screen via alternate-scroll mode) to the Transcript's scroll offset.
  // The Transcript owns the offset — it's the only place that knows the
  // wrapped line count — so it publishes a scroller into this ref.
  const transcriptScrollRef = useRef<(delta: number) => void>(() => {})

  // Ctrl+V: an image on the clipboard is *staged*, not sent — same as the
  // web UI's Composer (pendingImages + preview, sent together with whatever
  // text follows on Enter). Anything else falls back to a plain text paste
  // at the cursor, via a ref CommandLine publishes into (mirrors
  // transcriptScrollRef above — CommandLine owns its cursor/value state,
  // App owns the child_process call, this ref is the bridge).
  const pasteInsertRef = useRef<(text: string) => void>(() => {})
  const [pendingImages, setPendingImages] = useState<string[]>([])
  // Explicit routing of the current draft, reported by CommandLine and shown
  // in the StatusBar — the paste-safety net (a quoted "@builder" routes!).
  const [draftTargets, setDraftTargets] = useState<{ t: string[]; d: string[] } | null>(null)
  // Rows the multiline draft occupies (1..MAX_INPUT_ROWS), reported by
  // CommandLine — the extra rows are booked in Transcript's reservedRows.
  const [draftRows, setDraftRows] = useState(1)
  const pasteClipboard = () => {
    readClipboardImage()
      .then(async (img) => {
        if (img.ok) {
          setPendingImages((imgs) => [...imgs, img.dataUri])
          store.pushNotice(`📎 Image staged — write your message and press ⏎ to send.`)
          return
        }
        if (img.reason !== "no-image") {
          store.pushNotice(img.error, "error")
          return
        }
        const txt = await readClipboardText()
        if (txt.ok && txt.text) pasteInsertRef.current(txt.text)
      })
      .catch((err: unknown) =>
        store.pushNotice(err instanceof Error && err.message ? err.message : "Clipboard paste failed.", "error"),
      )
  }

  return (
    <Box flexDirection="column" height={Math.max(8, rows - 1)} overflow="hidden">
      <Box flexDirection="column" flexShrink={0}>
        <RoomTabs
          rooms={rooms}
          current={roomId}
          plusSelected={plusSelected}
          conversationTitle={
            state.conversations.find((c) => c.id === state.currentConversationId)?.title
          }
        />
        {/* Horizontal roster timeline (Dofus turn-bar style) — replaces the
            26-column sidebar, so the transcript gets the full width. Detail
            and actions live in Ctrl+R. */}
        <RosterStrip roster={state.roster} runningId={state.runningAgentId} defaultModel={state.defaultModel} />
        <TaskSummary tasks={state.tasks} />
        {/* Divider between the fixed header zone and the conversation — makes
            the task line read as chrome, not the first message. Always on; its
            row is booked in reservedRows below. */}
        <HeaderDivider width={columns} />
      </Box>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          <Transcript
            messages={state.messages}
            roster={state.roster}
            streaming={state.streaming}
            liveReasoning={state.liveReasoning}
            reasoningActive={state.reasoningActive}
            liveActivity={state.liveActivity}
            receipts={state.receipts}
            // Every row the fixed "rows - 8" budget doesn't know about must be
            // declared here, or the layout exceeds the screen and Ink
            // row-diffing corrupts (the vanished "── You ──" header,
            // 2026-07-09): the roster strip (1–3: cells + model row + usage
            // row), the task line (1 when the board is non-empty), and the
            // QCM picker while a paused question carries options — reserved
            // even while the picker is hidden by typing (stable layout beats
            // a jumping one).
            reservedRows={
              stripRowCount(state.roster, columns, state.defaultModel) +
              (state.tasks.length > 0 ? 1 : 0) +
              1 /* HeaderDivider: always-on rule under the header zone */ +
              (state.paused && state.pausedOptions?.length ? pickerRows(state.pausedOptions.length) : 0) +
              (draftRows - 1) /* multiline draft: rows beyond the input's booked one */
            }
            isActive={!overlay && !state.oauthProgress}
            scrollRef={transcriptScrollRef}
          />
        </Box>
      </Box>

      <Box flexDirection="column" flexShrink={0}>
      {overlay?.kind === "select" ? (
        <SelectOverlay
          // Keyed by title: chained select overlays (roster picker → agent
          // actions → kick confirm) are the same component type in the same
          // slot, so without a key React keeps the previous menu's cursor and
          // filter state across the transition.
          key={overlay.title}
          title={overlay.title}
          items={overlay.items}
          emptyText={overlay.emptyText}
          isActive
          onSelect={(id) => {
            // Close before dispatching: onSelect may open a follow-up overlay
            // (e.g. the API-key prompt), which a trailing close would clobber.
            closeOverlay()
            overlay.onSelect(id)
          }}
          onCancel={() => {
            closeOverlay()
            overlay.onCancel?.()
          }}
        />
      ) : null}
      {overlay?.kind === "textInput" ? (
        <TextInputOverlay
          title={overlay.title}
          placeholder={overlay.placeholder}
          mask={overlay.mask}
          isActive
          onSubmit={(value) => {
            closeOverlay()
            overlay.onSubmit(value)
          }}
          onCancel={closeOverlay}
        />
      ) : null}
      {overlay?.kind === "tasks" ? (
        <TasksOverlay tasks={state.tasks} roster={state.roster} isActive onClose={closeOverlay} />
      ) : null}
      {overlay?.kind === "lineup" ? (
        <LineupOverlay
          store={store}
          isActive
          onAddAgent={() => setOverlay({ kind: "agentForm" })}
          onClose={closeOverlay}
        />
      ) : null}
      {overlay?.kind === "agentForm" ? <AgentForm store={store} isActive onClose={closeOverlay} /> : null}
      {overlay?.kind === "roomForm" ? (
        <RoomForm
          api={api}
          isActive
          onClose={closeOverlay}
          onCreated={(id, name, hadGoal) => {
            switchRoom(id)
            refreshRooms()
            setPendingNotice(`Created room "${name}"${hadGoal ? " — goal started." : "."}`)
          }}
        />
      ) : null}
      {overlay?.kind === "prompt" ? (
        <PromptOverlay agentId={overlay.agentId} store={store} isActive onClose={closeOverlay} />
      ) : null}
      {overlay?.kind === "editAgent" ? (
        <EditAgentForm agentId={overlay.agentId} store={store} isActive onClose={closeOverlay} />
      ) : null}
      {overlay?.kind === "presetPicker" ? (
        <PresetPickerOverlay
          presets={overlay.presets}
          store={store}
          isActive
          onCancel={closeOverlay}
          onCompose={(preset, isNew) => setOverlay({ kind: "presetComposer", initial: preset, isNew })}
        />
      ) : null}
      {overlay?.kind === "presetComposer" ? (
        <PresetComposerOverlay
          initial={overlay.initial}
          isNew={overlay.isNew}
          api={api}
          store={store}
          isActive
          onClose={closeOverlay}
        />
      ) : null}
      {state.oauthProgress ? (
        <OAuthPanel
          progress={state.oauthProgress}
          isActive={!overlay}
          onDismiss={() => store.actions.dismissOAuth()}
          onSubmitInput={(value) => store.actions.submitOAuthInput(state.oauthProgress!.provider, value)}
        />
      ) : null}

      <Notices notices={state.notices} />
      <StatusBar
        draftTargets={draftTargets}
        connection={connection}
        turnActive={state.turnActive}
        runningAgent={runningAgent}
        runningSince={state.runningSince}
        paused={state.paused}
        pausedAskerId={state.pausedAskerId}
        routingMode={state.routingMode}
        roomId={store.roomId}
        messageCount={state.messages.length}
        drift={state.drift}
        roomUsage={state.roomUsage}
      />
      <CommandLine
        roster={state.roster}
        defaultAgent={state.defaultAgent}
        onRoutingPreview={setDraftTargets}
        onSend={(text) => {
          store.actions.send(text || "(image shared)", pendingImages.length > 0 ? pendingImages : undefined)
          setPendingImages([])
        }}
        onCommand={runCommand}
        onRoomNav={roomNav}
        onEmptyEnter={onEmptyEnter}
        onRoutingCycle={cycleRouting}
        onShell={runShell}
        onScroll={(delta) => transcriptScrollRef.current(delta)}
        onPaste={pasteClipboard}
        onToggleTasks={() => setOverlay((o) => (o?.kind === "tasks" ? null : { kind: "tasks" }))}
        onRosterMenu={() => runCommand("/roster")}
        onAbort={() => runCommand("/abort")}
        turnActive={state.turnActive}
        routingMode={state.routingMode}
        answerOptions={state.paused ? state.pausedOptions : null}
        pausedAskerId={state.pausedAskerId}
        pasteInsertRef={pasteInsertRef}
        pendingImageCount={pendingImages.length}
        onClearPending={() => setPendingImages([])}
        onDraftRows={setDraftRows}
        isActive={!overlay && !state.oauthProgress}
        connected={state.connected}
      />
      </Box>
    </Box>
  )
}
