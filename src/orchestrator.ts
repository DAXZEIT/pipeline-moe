// RoomOrchestrator — the capability surface that lets an agent (the planner)
// spawn, inspect, and tear down sub-rooms from inside a turn.
//
// The interface lives here, decoupled from its implementation (server.ts) and
// from the tools that consume it (custom-tools/spawn-room.ts etc.). This avoids
// a circular import between the tool registry and the server/room-manager, and
// keeps the tools testable against a mock orchestrator.

export interface SpawnRoomOptions {
  /** Display name for the sub-room. */
  name: string
  /** The goal the sub-room's agents work on autonomously. */
  goal: string
  /** Preset roster name (from presets/). Omit to use the default roster. */
  preset?: string
  /** Working directory scope — local path or user@host:/path (sshfs).
   *  Omit for the pipeline workspace. */
  workspaceDir?: string
}

export interface SpawnRoomResult {
  roomId: string
  name: string
  goalStatus: string
}

export interface CheckRoomResult {
  found: boolean
  roomId: string
  name?: string
  goalStatus?: string
  goalText?: string | null
  /** The last few transcript lines, "Author: text" formatted. */
  lastMessages?: string[]
}

export interface RoomOrchestrator {
  /** Create a room, load its roster, submit its goal. Fire-and-forget — the
   *  room runs in the background and this resolves once it has started. */
  spawnRoom(opts: SpawnRoomOptions): Promise<SpawnRoomResult>
  /** Read a sub-room's current goal status and recent transcript. */
  checkRoom(roomId: string): CheckRoomResult
  /** Destroy a sub-room (unmounts any sshfs target). Returns false if absent. */
  destroyRoom(roomId: string): Promise<boolean>
}
