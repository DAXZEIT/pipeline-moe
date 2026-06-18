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
 *  Only returns tools whose name appears in the allowlist. */
export function buildCustomTools(toolNames: string[]): ToolDefinition[] {
  const wanted = new Set(toolNames)
  const tools: ToolDefinition[] = []

  for (const { name, factory } of TOOLS) {
    if (wanted.has(name)) {
      tools.push(factory() as ToolDefinition)
    }
  }

  return tools
}

/** Get all available custom tool names (for validation / UI). */
export function availableCustomTools(): string[] {
  return TOOLS.map((t) => t.name)
}
