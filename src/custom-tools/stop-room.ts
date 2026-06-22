// stop_room — halt a sub-room's in-flight work WITHOUT destroying it. Aborts
// running agents and cancels the goal (status → "cancelled"); the room and its
// transcript survive so you can inspect what went wrong, then decide whether to
// re-dispatch or destroy_room to free resources. The default room is protected.

import { Type } from "typebox"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { RoomOrchestrator } from "../orchestrator.js"

const stopRoomSchema = Type.Object({
  roomId: Type.String({
    description: "The roomId of the sub-room to stop.",
  }),
})

export function createStopRoomToolDefinition(
  orchestrator: RoomOrchestrator,
): ToolDefinition<typeof stopRoomSchema, undefined> {
  return {
    name: "stop_room",
    label: "Stop Sub-Room",
    description:
      "Halt a sub-room that is running away or no longer needed, WITHOUT destroying it. Aborts its " +
      "running agents and cancels its goal (status becomes 'cancelled'); the room and its transcript " +
      "remain intact so you can inspect what happened with check_room. Call destroy_room afterwards " +
      "to free resources. Cannot stop the default room.",
    parameters: stopRoomSchema,
    execute: async (_toolCallId, params) => {
      try {
        const ok = await orchestrator.stopRoom(params.roomId)
        return {
          content: [{
            type: "text",
            text: ok
              ? `Stopped room "${params.roomId}" — goal cancelled, agents aborted. The room and its ` +
                `transcript are intact: check_room to inspect, or destroy_room to free resources.`
              : `stop_room: no room with id "${params.roomId}" (or it cannot be stopped — the default room is protected).`,
          }],
          details: undefined,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text", text: `stop_room error: ${msg}` }],
          details: undefined,
        }
      }
    },
  }
}
