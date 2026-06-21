import { useEffect, useRef, useState } from "react"
import { api, API_BASE } from "./api"
import { CreateRoomDialog } from "./components/CreateRoomDialog"
import { RoomView } from "./components/RoomView"
import type { RoomSummary } from "./types"

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

  return (
    <div className="app">
      {/* key={activeRoomId} forces a full unmount/remount on room switch: the
          old room's useRoom hook (SSE stream, state, callbacks) is torn down
          and a fresh one mounts. No shared hook instance = no cross-room turn
          relaunch. App itself never remounts, so global SSE + rooms state and
          the create dialog persist across switches. */}
      <RoomView
        key={activeRoomId}
        roomId={activeRoomId}
        rooms={rooms}
        onSwitch={setActiveRoomId}
        onCreateRoom={() => setShowCreateDialog(true)}
        onDestroyRoom={handleDestroyRoom}
        onRenameRoom={handleRenameRoom}
      />

      {showCreateDialog && (
        <CreateRoomDialog
          onClose={() => setShowCreateDialog(false)}
          onCreated={handleRoomCreated}
        />
      )}
    </div>
  )
}
