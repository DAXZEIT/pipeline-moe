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
import { createDestroyRoomToolDefinition } from "./destroy-room.js"
import type { RoomOrchestrator } from "../orchestrator.js"

/** Runtime context the tool registry needs to build context-dependent tools.
 *  Orchestration tools (spawn/check/destroy room) require a live orchestrator;
 *  they are only built when one is supplied. */
export interface ToolContext {
  orchestrator?: RoomOrchestrator
}

/** Orchestration tool names — gated on a RoomOrchestrator being present, not on
 *  the static TOOLS registry. Only orchestrator personas (the planner) get them. */
export const ORCHESTRATION_TOOLS = ["spawn_room", "check_room", "destroy_room"] as const

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
  const wantsOrch = [...ORCHESTRATION_TOOLS].filter(n => wanted.has(n))
  if (wantsOrch.length > 0) {
    console.log(`[buildCustomTools] orchestration tools requested: ${wantsOrch.join(", ")}; ctx?.orchestrator = ${!!ctx?.orchestrator}`)
  }
  if (ctx?.orchestrator) {
    const orch = ctx.orchestrator
    if (wanted.has("spawn_room")) tools.push(createSpawnRoomToolDefinition(orch) as ToolDefinition)
    if (wanted.has("check_room")) tools.push(createCheckRoomToolDefinition(orch) as ToolDefinition)
    if (wanted.has("destroy_room")) tools.push(createDestroyRoomToolDefinition(orch) as ToolDefinition)
  }

  return tools
}

/** Get all available custom tool names (for validation / UI). */
export function availableCustomTools(): string[] {
  return TOOLS.map((t) => t.name)
}
