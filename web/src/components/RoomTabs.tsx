import type { RoomSummary } from "../types"

interface Props {
  rooms: RoomSummary[]
  activeRoomId: string
  onSwitch: (roomId: string) => void
  onCreateRoom: () => void
  onDestroyRoom: (roomId: string) => void
  onStopRoom: (roomId: string) => void
  onRenameRoom: (roomId: string, name: string) => void
}

function statusDotClass(goalStatus: string): string {
  switch (goalStatus) {
    case "running":   return "status-dot running"
    case "completed": return "status-dot completed"
    case "failed":    return "status-dot failed"
    case "cancelled": return "status-dot cancelled"
    default:          return "status-dot idle"
  }
}

function statusLabel(goalStatus: string): string {
  switch (goalStatus) {
    case "running":   return "running"
    case "completed": return "done"
    case "failed":    return "failed"
    case "cancelled": return "stopped"
    default:          return ""
  }
}

export function RoomTabs({ rooms, activeRoomId, onSwitch, onCreateRoom, onDestroyRoom, onStopRoom, onRenameRoom }: Props) {
  const handleDestroy = (e: React.MouseEvent, roomId: string, name: string) => {
    e.stopPropagation()
    if (window.confirm(`Destroy room "${name}"? This cannot be undone.`)) {
      onDestroyRoom(roomId)
    }
  }

  const handleStop = (e: React.MouseEvent, roomId: string) => {
    e.stopPropagation()
    onStopRoom(roomId)
  }

  const handleRename = (e: React.MouseEvent, roomId: string, currentName: string) => {
    e.stopPropagation()
    const next = window.prompt("Rename room:", currentName)?.trim()
    if (next && next !== currentName) onRenameRoom(roomId, next)
  }

  return (
    <div className="room-tabs">
      {rooms.map((room) => {
        const isActive = room.roomId === activeRoomId
        const isDefault = room.roomId === "default"
        const label = statusLabel(room.goalStatus)
        return (
          <button
            key={room.roomId}
            className={`room-tab${isActive ? " active" : ""}`}
            onClick={() => onSwitch(room.roomId)}
            title={room.goalText ? `Goal: ${room.goalText}` : room.name}
          >
            <span className={statusDotClass(room.goalStatus)} aria-label={room.goalStatus} />
            <span
              className="room-tab-name"
              onDoubleClick={(e) => handleRename(e, room.roomId, room.name)}
              title="Double-click to rename"
            >
              {room.name}
            </span>
            {label && <span className="room-tab-status">{label}</span>}
            {room.goalStatus === "running" && (
              <span
                className="room-tab-stop"
                role="button"
                onClick={(e) => handleStop(e, room.roomId)}
                title={`Stop ${room.name} — cancels the running goal, keeps the transcript`}
              >
                ⏹
              </span>
            )}
            {!isDefault && (
              <span
                className="room-tab-close"
                role="button"
                onClick={(e) => handleDestroy(e, room.roomId, room.name)}
                title={`Destroy ${room.name}`}
              >
                ×
              </span>
            )}
          </button>
        )
      })}
      <button className="room-tab-new" onClick={onCreateRoom} title="Create a new room">
        + room
      </button>
    </div>
  )
}
