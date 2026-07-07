import { spawn } from "node:child_process"
import { Box } from "ink"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { RoomStore, Api, RoomSummary } from "@pipeline-moe/client-core"
import { useRoomStore } from "./useRoomStore"
import { Roster } from "./components/Roster"
import { RoomTabs } from "./components/RoomTabs"
import { Transcript } from "./components/Transcript"
import { StatusBar } from "./components/StatusBar"
import { CommandLine } from "./components/CommandLine"
import { Notices } from "./components/Notices"
import { OAuthPanel } from "./components/OAuthPanel"
import { SelectOverlay } from "./components/overlays/SelectOverlay"
import { TextInputOverlay } from "./components/overlays/TextInputOverlay"
import { LineupOverlay } from "./components/overlays/LineupOverlay"
import { AgentForm } from "./components/overlays/AgentForm"
import { RoomForm } from "./components/overlays/RoomForm"
import { PromptOverlay } from "./components/overlays/PromptOverlay"
import { EditAgentForm } from "./components/overlays/EditAgentForm"
import { PresetDetailOverlay } from "./components/overlays/PresetDetailOverlay"
import { lookup } from "./commands/registry"
import type { CommandContext, Overlay } from "./commands/types"
import { useTerminalSize } from "./useTerminalSize"

export function App({
  makeStore,
  api,
  initialRoomId,
}: {
  makeStore: (roomId: string) => RoomStore
  api: Api
  initialRoomId: string
}) {
  // The active room. Switching rooms swaps the store entirely (the store is
  // bound to one roomId at construction), mirroring the web's per-room store.
  const [roomId, setRoomId] = useState(initialRoomId)
  const store = useMemo(() => makeStore(roomId), [makeStore, roomId])

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
  const switchRoom = (id: string) => {
    setPlusSelected(false)
    if (id !== roomId) setRoomId(id)
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
    setPlusSelected(false)
    if (ids[next] !== roomId) setRoomId(ids[next])
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

  // ⇧⇥ cycles the routing mode without typing /route. The status bar reflects
  // the change as soon as the server broadcasts the settings.
  const cycleRouting = () => {
    const order = ["auto", "semi", "manual"] as const
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
      switchRoom,
      openOverlay: setOverlay,
      closeOverlay,
    }
    Promise.resolve(cmd.run(ctx, args)).catch(() => {})
  }

  // Pin the whole app to the terminal height. If the frame ever grows taller
  // than the screen (a tall overlay under a full transcript), Ink can no
  // longer erase the lines that scrolled off — they stay behind as ghost
  // frames. With a fixed-height root, the middle (roster + transcript) is the
  // only flexible region: it shrinks and clips while an overlay is open, and
  // the frame never exceeds the screen.
  const { rows } = useTerminalSize()

  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      <Box flexDirection="column" flexShrink={0}>
        <RoomTabs rooms={rooms} current={roomId} plusSelected={plusSelected} />
      </Box>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Roster roster={state.roster} width={26} />
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          <Transcript
            messages={state.messages}
            roster={state.roster}
            streaming={state.streaming}
            liveReasoning={state.liveReasoning}
            isActive={!overlay && !state.oauthProgress}
          />
        </Box>
      </Box>

      <Box flexDirection="column" flexShrink={0}>
      {overlay?.kind === "select" ? (
        <SelectOverlay
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
      {overlay?.kind === "presetDetail" ? (
        <PresetDetailOverlay
          preset={overlay.preset}
          store={store}
          isActive
          onClose={closeOverlay}
          onBack={overlay.onBack}
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
        connection={connection}
        turnActive={state.turnActive}
        runningAgent={runningAgent}
        routingMode={state.routingMode}
        roomId={store.roomId}
        messageCount={state.messages.length}
      />
      <CommandLine
        onSend={(text) => store.actions.send(text)}
        onCommand={runCommand}
        onRoomNav={roomNav}
        onEmptyEnter={onEmptyEnter}
        onRoutingCycle={cycleRouting}
        isActive={!overlay && !state.oauthProgress}
        connected={state.connected}
      />
      </Box>
    </Box>
  )
}
