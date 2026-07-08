// answer_room — send a message into a sub-room you orchestrate. If the
// sub-room is paused on an ask_orchestrator (or ask_user) question, this is
// the answer and resumes its pipeline; otherwise it lands as a normal message
// routed by the sub-room's own rules.

import { Type } from "typebox"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { RoomOrchestrator } from "../orchestrator.js"

const answerRoomSchema = Type.Object({
  roomId: Type.String({
    description: "The roomId of the sub-room to answer (from spawn_room / the question report).",
  }),
  text: Type.String({
    description:
      "Your answer or instruction. If the sub-room is paused on a question, this resumes it — " +
      "the asking agent receives this text directly.",
  }),
})

export function createAnswerRoomToolDefinition(
  orchestrator: RoomOrchestrator,
): ToolDefinition<typeof answerRoomSchema, undefined> {
  return {
    name: "answer_room",
    label: "Answer Sub-Room",
    description:
      "Send a message into a sub-room. If it is paused on an ask_orchestrator question, this is " +
      "the answer and resumes its pipeline (the asker receives it directly). Also usable to steer " +
      "a running sub-room mid-goal. Check state first with check_room when unsure.",
    parameters: answerRoomSchema,
    execute: async (_toolCallId, params) => {
      try {
        const ok = orchestrator.answerRoom(params.roomId, params.text)
        return {
          content: [{
            type: "text",
            text: ok
              ? `Delivered to room "${params.roomId}". If it was paused on a question, it is resuming now — ` +
                `you'll be notified when its goal resolves (or poll with check_room).`
              : `answer_room: no room with id "${params.roomId}".`,
          }],
          details: undefined,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text", text: `answer_room error: ${msg}` }],
          details: undefined,
        }
      }
    },
  }
}
