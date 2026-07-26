// destroy_room — tear down a sub-room after its goal is done. Unmounts any
// sshfs target the room was scoped to. The default room cannot be destroyed.

import { Type } from "typebox"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { RoomOrchestrator } from "../orchestrator.js"

const destroyRoomSchema = Type.Object({
  roomId: Type.String({
    description: "The roomId of the sub-room to destroy.",
  }),
})

export function createDestroyRoomToolDefinition(
  orchestrator: RoomOrchestrator,
): ToolDefinition<typeof destroyRoomSchema, undefined> {
  return {
    name: "destroy_room",
    label: "Destroy Sub-Room",
    description:
      "Destroy a sub-room once you have collected its result. Unmounts any sshfs target. " +
      "Call this after check_room shows the goal is completed or failed, to free resources. " +
      "This CASCADES: any room the target itself spawned is destroyed with it, so collect what " +
      "you need from the whole subtree first.",
    parameters: destroyRoomSchema,
    execute: async (_toolCallId, params) => {
      try {
        const destroyed = await orchestrator.destroyRoom(params.roomId)
        // Name the collateral: the caller asked for one room and may have taken
        // down a subtree it never listed.
        const others = destroyed.filter((id) => id !== params.roomId)
        return {
          content: [{
            type: "text",
            text: destroyed.length > 0
              ? `Destroyed room "${params.roomId}".` +
                (others.length > 0
                  ? ` Its ${others.length} sub-room(s) went with it: ${others.join(", ")}.`
                  : "")
              : `destroy_room: no room with id "${params.roomId}" (or it cannot be destroyed).`,
          }],
          details: undefined,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text", text: `destroy_room error: ${msg}` }],
          details: undefined,
        }
      }
    },
  }
}
