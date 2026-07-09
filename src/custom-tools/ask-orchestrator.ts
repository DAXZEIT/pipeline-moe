// ask_orchestrator — escalate from a spawned sub-room to the agent that
// spawned it (usually the parent room's planner). Only exists in rooms that
// have a ParentLink, i.e. rooms created via spawn_room.
//
// Two things happen: (1) the question is delivered into the parent room and
// triggers the spawner's turn there; (2) this room pauses at the end of the
// current turn — Participant extracts the question exactly like ask_user, so
// the pipeline (including a goal-eval loop) freezes until the answer arrives
// via answer_room, which resumes the asker directly.

import { Type } from "typebox"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { ParentLink } from "../orchestrator.js"

const askOrchestratorSchema = Type.Object({
  question: Type.String({
    description:
      "The question or decision you need from the orchestrator. Be specific and self-contained — " +
      "the orchestrator does not see this room's conversation.",
  }),
})

export function createAskOrchestratorToolDefinition(
  link: ParentLink,
  personaId: string,
): ToolDefinition<typeof askOrchestratorSchema, undefined> {
  return {
    name: "ask_orchestrator",
    label: "Ask Orchestrator",
    description:
      "Escalate a question to the orchestrator that spawned this room (in its parent room) and " +
      "PAUSE this room until the answer arrives. Use it when you are blocked on a decision that " +
      "is outside this room's goal — ambiguous requirements, two viable paths, missing access. " +
      "Like ask_user, the pipeline freezes at the end of your turn; end your turn right after " +
      "asking. Do NOT use it for questions this room can answer itself.",
    parameters: askOrchestratorSchema,
    execute: async (_toolCallId, params) => {
      try {
        link.report(
          `❓ Sub-room "${link.childName}" (roomId: ${link.childRoomId}) — @${personaId} asks:\n\n` +
            `${params.question}\n\n` +
            `The sub-room is paused on this question. Answer with ` +
            `answer_room({ roomId: "${link.childRoomId}", text: "..." }) — your answer resumes it. ` +
            `You can inspect it first with check_room({ roomId: "${link.childRoomId}" }).`,
        )
        // terminate: true is load-bearing (see F6/F6b). "End your turn now" in
        // the text was advisory-only — the agent loop doesn't stop on its own,
        // it just keeps generating. A chatty model called this repeatedly
        // within one turn (3 duplicate escalations for one stuck state,
        // observed live) because nothing forced the loop to actually end.
        // Setting terminate: true is what pi-agent-core's runLoop checks to
        // skip re-invoking the model in this turn. Only on the success path—
        // the catch below deliberately omits it so the model can see the
        // delivery error and decide how to proceed.
        return {
          content: [{
            type: "text",
            text:
              `Question delivered to the orchestrator (@${link.parentAgentId} in room "${link.parentRoomId}"). ` +
              `This room will pause at the end of your turn until the answer arrives — end your turn now.`,
          }],
          details: undefined,
          terminate: true,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text", text: `ask_orchestrator error: ${msg}` }],
          details: undefined,
        }
      }
    },
  }
}
