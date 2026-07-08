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
  goalMode: Type.Optional(
    Type.Union([Type.Literal("auto"), Type.Literal("eval")], {
      description:
        "Goal completion mode. 'auto' (default): the goal completes when the sub-room's pipeline " +
        "drains. 'eval': after each pass the evaluator agent re-enters the sub-room, verifies " +
        "the goal independently with tools, and either dispatches more work or declares GOAL_MET. Use " +
        "'eval' for iterative goals that need a verification loop.",
    }),
  ),
  goalEvaluator: Type.Optional(
    Type.String({
      description:
        "Agent id that evaluates the goal in 'eval' mode (e.g. 'planner', 'auditor'). Defaults to " +
        "'planner'. Must match a persona id in the sub-room's roster, or the goal will auto-complete " +
        "without verification.",
    }),
  ),
  maxGoalIterations: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 50,
      description:
        "Max evaluation iterations before the goal auto-fails in 'eval' mode. Default 10. Each " +
        "iteration is one evaluator verification pass plus any agents it dispatches.",
    }),
  ),
})

export function createSpawnRoomToolDefinition(
  orchestrator: RoomOrchestrator,
  /** The spawning room + agent. When present, the sub-room reports back here
   *  when its goal resolves, and its agents can ask_orchestrator mid-goal. */
  spawnedBy?: { roomId: string; agentId: string },
): ToolDefinition<typeof spawnRoomSchema, undefined> {
  return {
    name: "spawn_room",
    label: "Spawn Sub-Room",
    description:
      "Create a new parallel room with its own agents and give it a goal. The room runs " +
      "independently in the background — use this to delegate a bounded, self-contained workstream. " +
      "When its goal resolves (completed/failed/cancelled) you are automatically woken with a report " +
      "in this room — no polling needed; check_room remains available to inspect progress mid-run, " +
      "and its agents can escalate questions to you via ask_orchestrator (answer with answer_room). " +
      "For an autonomous build/verify loop, use goalMode 'eval' with an evaluator like 'auditor'. " +
      "The sub-room does NOT share your conversation, so the goal must be fully self-contained. " +
      "Clean up with destroy_room once you've integrated the result.",
    parameters: spawnRoomSchema,
    execute: async (_toolCallId, params) => {
      try {
        const r = await orchestrator.spawnRoom({
          name: params.name,
          goal: params.goal,
          preset: params.preset,
          workspaceDir: params.workspaceDir,
          goalMode: params.goalMode,
          goalEvaluator: params.goalEvaluator,
          maxGoalIterations: params.maxGoalIterations,
          spawnedBy,
        })
        return {
          content: [{
            type: "text",
            text:
              `Spawned room "${r.name}" — roomId: ${r.roomId}, status: ${r.goalStatus}.\n` +
              (spawnedBy
                ? `You will be woken with a report in this room when its goal resolves. ` +
                  `Inspect anytime with check_room({ roomId: "${r.roomId}" }); ` +
                  `destroy_room({ roomId: "${r.roomId}" }) once done.`
                : `Poll with check_room({ roomId: "${r.roomId}" }) until status is "completed" or "failed", ` +
                  `then destroy_room({ roomId: "${r.roomId}" }) to clean up.`),
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
