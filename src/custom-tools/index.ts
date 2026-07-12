// Custom tools registry — extension point for Pipeline-MoE.
// Each custom tool is a standalone ToolDefinition. Add new tools here
// and register them in the index. The allowlist in `persona.tools` gates
// which tools each agent gets.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import { createWebSearchToolDefinition } from "./web-search.js"
import { createWebReadToolDefinition } from "./web-read.js"
import { createYoutubeTranscriptToolDefinition } from "./youtube-transcript.js"
import { createArxivSearchToolDefinition } from "./arxiv-search.js"
import { createYoucomSearchToolDefinition } from "./youcom-search.js"
import { createSpawnRoomToolDefinition } from "./spawn-room.js"
import { createCheckRoomToolDefinition } from "./check-room.js"
import { createStopRoomToolDefinition } from "./stop-room.js"
import { createDestroyRoomToolDefinition } from "./destroy-room.js"
import {
  createTaskCreateToolDefinition,
  createTaskListToolDefinition,
  createTaskUpdateToolDefinition,
} from "./task-tools.js"
import { createAskOrchestratorToolDefinition } from "./ask-orchestrator.js"
import { createAnswerRoomToolDefinition } from "./answer-room.js"
import { createHandoffToolDefinition } from "./handoff.js"
import { createGoalVerdictToolDefinition } from "./goal-verdict.js"
import type { ParentLink, RoomOrchestrator } from "../orchestrator.js"
import type { TaskBoard } from "../task-board.js"
import type { GoalVerdictSink, HandoffSink } from "../types.js"

/** Runtime context the tool registry needs to build context-dependent tools.
 *  Orchestration tools (spawn/check/destroy room) require a live orchestrator;
 *  task tools require the room's TaskBoard; ask_orchestrator requires a
 *  ParentLink (only spawned sub-rooms have one). Each is built when supplied. */
export interface ToolContext {
  orchestrator?: RoomOrchestrator
  taskBoard?: TaskBoard
  /** Id of the persona these tools are being built for (task attribution). */
  personaId?: string
  /** Id of the room these tools run in — spawn_room records it as the parent. */
  roomId?: string
  /** Link back to the parent room, present only in spawned sub-rooms. */
  parentLink?: ParentLink
  /** Capability for the handoff tool — the room's live roster (Registry
   *  implements this). Present in every room; the tool itself is only
   *  granted when at least one OTHER active agent exists to hand off to. */
  handoffSink?: HandoffSink
  /** Capability for the goal_verdict tool (Registry implements this too).
   *  The tool is granted to the room's evaluator seat only. */
  goalVerdictSink?: GoalVerdictSink
}

/** Orchestration tool names — gated on a RoomOrchestrator being present, not on
 *  the static TOOLS registry. Only orchestrator personas (the planner) get them. */
export const ORCHESTRATION_TOOLS = ["spawn_room", "check_room", "stop_room", "destroy_room", "answer_room"] as const

// Registry of tool name → factory function.
// Add new tools here — each tool is a self-contained module.
// Factory is typed loosely to avoid contravariance issues with ToolDefinition
// generics — the actual type safety is enforced in each tool's definition.
const TOOLS: Array<{ name: string; factory: () => unknown }> = [
  { name: "web_search", factory: createWebSearchToolDefinition },
  { name: "web_read", factory: createWebReadToolDefinition },
  { name: "youtube_transcript", factory: createYoutubeTranscriptToolDefinition },
  { name: "arxiv_search", factory: createArxivSearchToolDefinition },
  { name: "youcom_search", factory: createYoucomSearchToolDefinition },
]

/** Build custom tool definitions for the given tool name allowlist.
 *  Only returns tools whose name appears in the allowlist. Orchestration tools
 *  (spawn/check/destroy room) are only built when `ctx.orchestrator` is supplied. */
export function buildCustomTools(toolNames: string[], ctx?: ToolContext): ToolDefinition[] {
  const wanted = new Set(toolNames)
  const tools: ToolDefinition[] = []

  for (const { name, factory } of TOOLS) {
    if (wanted.has(name)) {
      tools.push(factory() as ToolDefinition)
    }
  }

  // Orchestration tools — context-gated. Require a live orchestrator reference
  // captured at execution time. Absent orchestrator → these names are silently
  // ignored (same contract as unknown tool names).
  if (ctx?.orchestrator) {
    const orch = ctx.orchestrator
    // Spawner identity: recorded on spawned rooms so they report back (goal
    // resolution + ask_orchestrator) instead of being fire-and-forget.
    const spawnedBy = ctx.roomId && ctx.personaId ? { roomId: ctx.roomId, agentId: ctx.personaId } : undefined
    if (wanted.has("spawn_room")) tools.push(createSpawnRoomToolDefinition(orch, spawnedBy) as ToolDefinition)
    if (wanted.has("check_room")) tools.push(createCheckRoomToolDefinition(orch) as ToolDefinition)
    if (wanted.has("stop_room")) tools.push(createStopRoomToolDefinition(orch) as ToolDefinition)
    if (wanted.has("destroy_room")) tools.push(createDestroyRoomToolDefinition(orch) as ToolDefinition)
    if (wanted.has("answer_room")) tools.push(createAnswerRoomToolDefinition(orch) as ToolDefinition)
  }

  // ask_orchestrator — context-gated on the parent link, NOT on the persona
  // allowlist: every agent of a spawned sub-room can escalate to its spawner.
  if (ctx?.parentLink) {
    tools.push(createAskOrchestratorToolDefinition(ctx.parentLink, ctx.personaId ?? "unknown") as ToolDefinition)
  }

  // Task-board tools — context-gated like orchestration tools, but NOT gated
  // on the persona allowlist: every agent in a room with a board gets them
  // (coordination primitive, not a privilege — and personas persisted before
  // this feature would otherwise never receive them).
  if (ctx?.taskBoard) {
    tools.push(createTaskCreateToolDefinition(ctx.taskBoard, ctx.personaId ?? "unknown") as ToolDefinition)
    tools.push(createTaskUpdateToolDefinition(ctx.taskBoard) as ToolDefinition)
    tools.push(createTaskListToolDefinition(ctx.taskBoard) as ToolDefinition)
  }

  // handoff — context-gated like the task board (every agent gets it, no
  // allowlist entry), but ALSO gated on there being at least one other
  // active agent to hand off to. A single-agent room has no valid target,
  // so the tool would offer an empty enum — omit it entirely rather than
  // build a tool that can never succeed.
  if (ctx?.handoffSink) {
    const personaId = ctx.personaId ?? "unknown"
    const others = ctx.handoffSink.activeIds().filter((id) => id !== personaId)
    if (others.length > 0) {
      tools.push(createHandoffToolDefinition(ctx.handoffSink, personaId) as ToolDefinition)
    }
  }

  // goal_verdict — context-gated to the room's goal-evaluator seat ONLY
  // (build-time id match; execution re-checks live). Not allowlist-gated for
  // the same reason as handoff (the F0 VALID_TOOLS drift class), and NOT
  // granted to workers: small models call any tool they are shown (the
  // scribe's spurious task_update, 2026-07-12), so the verdict menu stays off
  // their schemas entirely. A goal submitted later with a different evaluator
  // leaves that seat tool-less — the eval loop's GOAL_MET token fallback and
  // format-repair retry still carry that case.
  if (ctx?.goalVerdictSink && ctx.personaId && ctx.goalVerdictSink.goalEvaluatorId() === ctx.personaId) {
    tools.push(createGoalVerdictToolDefinition(ctx.goalVerdictSink, ctx.personaId) as ToolDefinition)
  }

  return tools
}

/** Get all available custom tool names (for validation / UI). */
export function availableCustomTools(): string[] {
  return TOOLS.map((t) => t.name)
}
