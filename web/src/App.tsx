import { useEffect, useRef, useState } from "react"
import { api, API_BASE } from "./api"
import { Composer } from "./components/Composer"
import { ConversationBar } from "./components/ConversationBar"
import { CreateRoomDialog } from "./components/CreateRoomDialog"
import { PresetMenu } from "./components/PresetMenu"
import { ProvidersPanel } from "./components/ProvidersPanel"
import { Roster } from "./components/Roster"
import { RoomTabs } from "./components/RoomTabs"
import { Transcript } from "./components/Transcript"
import { WorkspacePanel } from "./components/WorkspacePanel"
import type { RoomSummary } from "./types"
import { useRoom } from "./useRoom"

export default function App() {
  const [activeRoomId, setActiveRoomId] = useState("default")
  const [rooms, setRooms] = useState<RoomSummary[]>([
    { roomId: "default", name: "main-room", participantCount: 0, goalStatus: "idle", goalText: null },
  ])
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const activeRoomIdRef = useRef(activeRoomId)
  activeRoomIdRef.current = activeRoomId

  // Fetch rooms list on mount.
  useEffect(() => {
    api.listRooms().then(setRooms).catch(() => {})
  }, [])

  // Listen for room lifecycle events on the global SSE stream.
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/events`)
    es.addEventListener("room", (e) => {
      const data = JSON.parse((e as MessageEvent).data)
      if (data.type === "created") {
        setRooms((r) => {
          // Avoid duplicates (e.g. if we already added on createRoom success).
          if (r.some((rm) => rm.roomId === data.roomId)) return r
          return [...r, {
            roomId: data.roomId,
            name: data.name,
            participantCount: data.participantCount ?? 0,
            goalStatus: "running",
            goalText: null,
          }]
        })
      } else if (data.type === "destroyed") {
        setRooms((r) => r.filter((rm) => rm.roomId !== data.roomId))
        if (activeRoomIdRef.current === data.roomId) setActiveRoomId("default")
      } else if (data.type === "renamed") {
        setRooms((r) => r.map((rm) =>
          rm.roomId === data.roomId ? { ...rm, name: data.name } : rm,
        ))
      } else if (data.type === "goal-completed") {
        setRooms((r) => r.map((rm) =>
          rm.roomId === data.roomId ? { ...rm, goalStatus: "completed" } : rm,
        ))
      } else if (data.type === "goal-failed") {
        setRooms((r) => r.map((rm) =>
          rm.roomId === data.roomId ? { ...rm, goalStatus: "failed" } : rm,
        ))
      }
    })
    return () => es.close()
  }, [])

  const handleDestroyRoom = (roomId: string) => {
    api.destroyRoom(roomId).then(() => {
      setRooms((r) => r.filter((rm) => rm.roomId !== roomId))
      if (activeRoomId === roomId) setActiveRoomId("default")
    }).catch((err) => {
      console.error("Failed to destroy room:", err)
    })
  }

  const handleRenameRoom = (roomId: string, name: string) => {
    api.renameRoom(roomId, name).then(() => {
      setRooms((r) => r.map((rm) => (rm.roomId === roomId ? { ...rm, name } : rm)))
    }).catch((err) => {
      console.error("Failed to rename room:", err)
    })
  }

  const handleRoomCreated = (newRoom: RoomSummary) => {
    setRooms((r) => {
      if (r.some((rm) => rm.roomId === newRoom.roomId)) return r
      return [...r, newRoom]
    })
    setActiveRoomId(newRoom.roomId)
    setShowCreateDialog(false)
  }

  // The active room's hook — key={activeRoomId} in the container forces full remount on switch.
  const room = useRoom(activeRoomId)

  return (
    <div className="app">
      <aside className="sidebar">
        <Roster
          roster={room.roster}
          connected={room.connected}
          defaultAgent={room.defaultAgent}
          turnActive={room.turnActive}
          onSetActive={room.setActive}
          onSetParallel={room.setParallel}
          onSetDefault={room.setDefaultAgent}
          onKick={room.kick}
          onCompact={room.compactAgent}
          onCreate={room.createParticipant}
          onReorder={room.reorderParticipants}
        />

        <ProvidersPanel
          providers={room.providers}
          _explicitlyEnabled={room.explicitlyEnabled}
          onAdd={room.addProvider}
          onRemove={room.removeProvider}
          onLogin={room.loginProvider}
        />
      </aside>

      <main className="center" key={activeRoomId}>
        <RoomTabs
          rooms={rooms}
          activeRoomId={activeRoomId}
          onSwitch={setActiveRoomId}
          onCreateRoom={() => setShowCreateDialog(true)}
          onDestroyRoom={handleDestroyRoom}
          onRenameRoom={handleRenameRoom}
        />

        <header className="topbar">
          <span className="brand">Pipeline-MoE</span>
          <ConversationBar
            conversations={room.conversations}
            currentId={room.currentConversationId}
            turnActive={room.turnActive}
            onSwitch={room.loadConversation}
            onNew={room.newConversation}
            onRename={room.renameConversation}
            onDelete={room.deleteConversation}
          />
          <PresetMenu turnActive={room.turnActive} />
          <span className="topbar-sub">{room.turnActive ? "agents running…" : "ready"}</span>
          <button
            className={`chain-toggle ${room.chaining ? "on" : ""}`}
            onClick={() => room.setChaining(!room.chaining)}
            title="When on, agents can summon each other via @mentions"
          >
            ⟳ chaining {room.chaining ? "on" : "off"}
          </button>
          {room.chaining && (
            <label className="chain-hops" title="Max chain hops per turn (1–100)">
              hops
              <input
                type="number"
                min={1}
                max={100}
                value={room.maxChainHops}
                onChange={(e) => room.setMaxChainHops(Number(e.target.value))}
              />
            </label>
          )}
        </header>
        <Transcript
          messages={room.messages}
          streaming={room.streaming}
          liveActivity={room.liveActivity}
          liveReasoning={room.liveReasoning}
          receipts={room.receipts}
          roster={room.roster}
        />
        <Composer
          roster={room.roster}
          turnActive={room.turnActive}
          runningAgentId={room.runningAgentId}
          paused={room.paused}
          pausedQuestion={room.pausedQuestion ?? null}
          pausedAskerId={room.pausedAskerId ?? null}
          onSend={room.send}
          onAbort={room.abort}
          onSteer={room.steer}
        />
      </main>

      <WorkspacePanel files={room.workspace} />

      {showCreateDialog && (
        <CreateRoomDialog
          onClose={() => setShowCreateDialog(false)}
          onCreated={handleRoomCreated}
        />
      )}

      <div className="notices">
        {room.notices.map((n) => (
          <div key={n.id} className={`notice notice-${n.level}`}>
            {n.msg}
          </div>
        ))}
      </div>
    </div>
  )
}
