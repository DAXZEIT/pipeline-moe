// spawn_room — create a parallel sub-room with its own agents and a goal.
// The room runs independently in the background; this tool returns immediately
// with the roomId. Poll progress with check_room, clean up with destroy_room.

import { Type } from "typebox"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { RoomOrchestrator } from "../orchestrator.js"

const spawnRoomSchema = Type.Object({
  name: Type.String({
    description: "Display name for the sub-room (e.g. 'audit-auth-flow').",
  }),
  goal: Type.String({
    description:
      "The goal the sub-room's agents will work on autonomously. Be specific and self-contained — the sub-room does not share your conversation context.",
  }),
  preset: Type.Optional(
    Type.String({
      description:
        "Preset roster name (from presets/, e.g. 'local-default'). Omit to use the default roster.",
    }),
  ),
  workspaceDir: Type.Optional(
    Type.String({
      description:
        "Working directory scope — a local path or an sshfs target (user@host:/path). Omit for the pipeline workspace.",
    }),
  ),
})

export function createSpawnRoomToolDefinition(
  orchestrator: RoomOrchestrator,
): ToolDefinition<typeof spawnRoomSchema, undefined> {
  return {
    name: "spawn_room",
    label: "Spawn Sub-Room",
    description:
      "Create a new parallel room with its own agents and give it a goal. The room runs " +
      "independently in the background — use this to delegate a bounded, self-contained workstream. " +
      "Returns the roomId; poll progress with check_room and clean up with destroy_room. " +
      "The sub-room does NOT share your conversation, so the goal must be fully self-contained.",
    parameters: spawnRoomSchema,
    execute: async (_toolCallId, params) => {
      try {
        const r = await orchestrator.spawnRoom({
          name: params.name,
          goal: params.goal,
          preset: params.preset,
          workspaceDir: params.workspaceDir,
        })
        return {
          content: [{
            type: "text",
            text:
              `Spawned room "${r.name}" — roomId: ${r.roomId}, status: ${r.goalStatus}.\n` +
              `Poll with check_room({ roomId: "${r.roomId}" }) until status is "completed" or "failed", ` +
              `then destroy_room({ roomId: "${r.roomId}" }) to clean up.`,
          }],
          details: undefined,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text", text: `spawn_room error: ${msg}` }],
          details: undefined,
        }
      }
    },
  }
}
