// check_room — read a sub-room's goal status and recent transcript so the
// spawning agent can decide whether to keep waiting or synthesize the result.

import { Type } from "typebox"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { RoomOrchestrator } from "../orchestrator.js"

const checkRoomSchema = Type.Object({
  roomId: Type.String({
    description: "The roomId returned by spawn_room.",
  }),
})

export function createCheckRoomToolDefinition(
  orchestrator: RoomOrchestrator,
): ToolDefinition<typeof checkRoomSchema, undefined> {
  return {
    name: "check_room",
    label: "Check Sub-Room",
    description:
      "Read a sub-room's current goal status (idle/running/completed/failed) and its last few " +
      "transcript messages. Poll this after spawn_room until the goal is completed or failed, " +
      "then synthesize the result and destroy the room.",
    parameters: checkRoomSchema,
    execute: async (_toolCallId, params) => {
      const r = orchestrator.checkRoom(params.roomId)
      if (!r.found) {
        return {
          content: [{ type: "text", text: `check_room: no room with id "${params.roomId}".` }],
          details: undefined,
        }
      }
      const header =
        `Room "${r.name}" (${r.roomId}) — goal status: ${r.goalStatus}` +
        (r.goalText ? `\nGoal: ${r.goalText}` : "")
      const body = r.lastMessages && r.lastMessages.length > 0
        ? `\n\nLast messages:\n${r.lastMessages.join("\n")}`
        : "\n\n(no transcript yet)"
      return {
        content: [{ type: "text", text: header + body }],
        details: undefined,
      }
    },
  }
}
