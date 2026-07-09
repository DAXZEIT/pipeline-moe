// Validation utilities extracted from server.ts for testability.

import type { Persona } from "./types.js"
import { ORCHESTRATION_TOOLS } from "./custom-tools/index.js"

// Base tools + orchestration tools (spawn_room, check_room, stop_room,
// destroy_room, answer_room). ORCHESTRATION_TOOLS is the source of truth —
// keeping the two in sync avoids a repeat of the 0.1.22 defect where these
// tools were wired into buildCustomTools() but silently stripped by this
// allowlist on every create/edit (only the code-built seed planner escaped it).
// Note: being in VALID_TOOLS makes a tool *grantable* via the API to any
// persona — assignment discipline ("only the planner gets these") stays a
// roster convention, not an allowlist restriction; buildCustomTools() already
// gates actual behavior on ctx.orchestrator/ctx.parentLink being present.
export const VALID_TOOLS = new Set([
  "read", "bash", "edit", "write", "grep", "find", "ls",
  "web_search", "web_read", "youtube_transcript", "arxiv_search", "youcom_search",
  ...ORCHESTRATION_TOOLS,
])

function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function parsePersona(body: Record<string, unknown>): Persona {
  const name = String(body.name ?? "").trim()
  if (!name) throw new Error("`name` is required")
  const id = slug(String(body.id ?? name))
  if (!id) throw new Error("could not derive a valid id from name")

  const tools = Array.isArray(body.tools)
    ? body.tools.map(String).filter((t) => VALID_TOOLS.has(t))
    : ["read", "grep", "find", "ls"]

  const systemPrompt = String(body.systemPrompt ?? "").trim()
  if (!systemPrompt) throw new Error("`systemPrompt` is required")

  return {
    id,
    name,
    color: String(body.color ?? "#888888"),
    icon: String(body.icon ?? "🤖"),
    tools,
    systemPrompt,
  }
}
