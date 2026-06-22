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
            goalStatus: data.goalStatus ?? "idle",
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
      } else if (data.type === "goal-cancelled" || data.type === "stopped") {
        setRooms((r) => r.map((rm) =>
          rm.roomId === data.roomId ? { ...rm, goalStatus: "cancelled" } : rm,
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

  const handleStopRoom = (roomId: string) => {
    // Optimistically reflect the stop; the room's goal-cancelled SSE confirms it.
    // Only the tabs' Stop button calls this (gated on goalStatus === "running"),
    // so "cancelled" is the correct resulting state.
    api.abortRoom(roomId).then(() => {
      setRooms((r) => r.map((rm) => (rm.roomId === roomId ? { ...rm, goalStatus: "cancelled" } : rm)))
    }).catch((err) => {
      console.error("Failed to stop room:", err)
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
      {/* Every open room stays mounted; only the active one is shown (the rest
          are display:none). Each RoomView keeps its OWN useRoom instance (SSE
          stream + live streaming/activity state) alive across switches, so an
          agent writing in one room isn't torn down when you peek at another and
          its in-flight output isn't lost. Distinct instances per roomId = no
          shared hook, so no cross-room turn relaunch. The wrapper uses
          display:contents so each RoomView's panels still flow into the .app
          grid when active. */}
      {rooms.map((rm) => (
        <div
          key={rm.roomId}
          style={{ display: rm.roomId === activeRoomId ? "contents" : "none" }}
        >
          <RoomView
            roomId={rm.roomId}
            active={rm.roomId === activeRoomId}
            rooms={rooms}
            onSwitch={setActiveRoomId}
            onCreateRoom={() => setShowCreateDialog(true)}
            onDestroyRoom={handleDestroyRoom}
            onStopRoom={handleStopRoom}
            onRenameRoom={handleRenameRoom}
          />
        </div>
      ))}

      {showCreateDialog && (
        <CreateRoomDialog
          onClose={() => setShowCreateDialog(false)}
          onCreated={handleRoomCreated}
        />
      )}
    </div>
  )
}
