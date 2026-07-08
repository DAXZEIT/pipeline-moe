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
  /** Goal completion mode. "auto" (default): the goal completes when the
   *  pipeline drains naturally. "eval": after each drain the evaluator agent
   *  verifies the goal independently and either dispatches more work or declares
   *  GOAL_MET. */
  goalMode?: "auto" | "eval"
  /** Agent id that evaluates the goal in "eval" mode. Defaults to "planner". */
  goalEvaluator?: string
  /** Max eval iterations before the goal auto-fails (eval mode only). Default 10. */
  maxGoalIterations?: number
  /** Who spawned this room. When set, the loop closes automatically: the
   *  sub-room reports back into this room (routed to this agent) when its
   *  goal resolves, and its agents get the ask_orchestrator escalation tool. */
  spawnedBy?: { roomId: string; agentId: string }
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
  /** Stop a sub-room's in-flight pipeline WITHOUT destroying it: aborts running
   *  agents and cancels any goal (status → "cancelled"), leaving the room and its
   *  transcript intact so the caller can inspect why it ran away. Returns false
   *  when the room is absent or protected (the default room cannot be stopped). */
  stopRoom(roomId: string): Promise<boolean>
  /** Destroy a sub-room (aborts it, then unmounts any sshfs target). Returns false if absent. */
  destroyRoom(roomId: string): Promise<boolean>
  /** Send a message into a sub-room. If the sub-room is paused on an
   *  ask_orchestrator/ask_user question, this is the answer and resumes it.
   *  Returns false when the room is absent. */
  answerRoom(roomId: string, text: string): boolean
}

/** The link a spawned sub-room holds back to its parent. Built by the server
 *  at provision time; consumed by the sub-room's ask_orchestrator tool and by
 *  the goal-resolution callback. `childRoomId` is filled in as soon as the id
 *  is minted (before the room object exists), so tools can reference it. */
export interface ParentLink {
  parentRoomId: string
  parentAgentId: string
  childRoomId: string
  childName: string
  /** Deliver a message into the parent room, routed to `parentAgentId`. */
  report(text: string): void
}
