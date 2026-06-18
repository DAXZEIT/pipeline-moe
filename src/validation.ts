// Validation utilities extracted from server.ts for testability.

import type { Persona } from "./types.js"

export const VALID_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "web_search"])

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
