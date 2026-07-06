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
import { PresetDetailOverlay } from "./components/overlays/PresetDetailOverlay"
import { lookup } from "./commands/registry"
import type { CommandContext, Overlay } from "./commands/types"

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
  const switchRoom = (id: string) => {
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
    if (rooms.length < 2) return
    const ids = rooms.map((r) => r.roomId)
    const at = ids.indexOf(roomId)
    switchRoom(ids[(Math.max(at, 0) + dir + ids.length) % ids.length])
  }

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

  return (
    <Box flexDirection="column" flexGrow={1}>
      <RoomTabs rooms={rooms} current={roomId} />
      <Box flexGrow={1}>
        <Roster roster={state.roster} width={26} />
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          <Transcript
            messages={state.messages}
            roster={state.roster}
            streaming={state.streaming}
            isActive={!overlay && !state.oauthProgress}
          />
        </Box>
      </Box>

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
        isActive={!overlay && !state.oauthProgress}
        connected={state.connected}
      />
    </Box>
  )
}
