// Validation utilities extracted from server.ts for testability.

import type { HandoffGate, Persona } from "./types.js"
import type { PresetPersona } from "./preset-hydration.js"
import { ORCHESTRATION_TOOLS } from "./custom-tools/index.js"
import { validateSeatModels } from "./seats.js"

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

/** Validate a `handoffGates` payload: an array of {from, via, when?}.
 *  Returns the normalized gates, or a string describing the first problem. */
export function parseHandoffGates(raw: unknown): HandoffGate[] | string {
  if (!Array.isArray(raw)) return "`handoffGates` must be an array"
  const gates: HandoffGate[] = []
  for (const [i, g] of raw.entries()) {
    if (!g || typeof g !== "object") return `handoffGates[${i}] must be an object`
    const { from, via, when } = g as Record<string, unknown>
    if (typeof from !== "string" || !from.trim()) return `handoffGates[${i}].from must be a non-empty string`
    if (typeof via !== "string" || !via.trim()) return `handoffGates[${i}].via must be a non-empty string`
    if (from.trim() === via.trim()) return `handoffGates[${i}]: from and via must differ`
    if (when !== undefined && (!Array.isArray(when) || when.some((w) => typeof w !== "string" || !w.trim()))) {
      return `handoffGates[${i}].when must be an array of non-empty glob strings`
    }
    gates.push({
      from: from.trim(),
      via: via.trim(),
      ...(when !== undefined && (when as string[]).length > 0 ? { when: (when as string[]).map((w) => w.trim()) } : {}),
    })
  }
  return gates
}

export const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"])

/** Non-blocking advice attached to an accepted preset document. */
export interface PresetWarning {
  personaId?: string
  message: string
}

/** A full preset document as accepted by PUT /api/presets/:name. Structurally
 *  identical to server.ts's PresetFile — declared here so validation stays
 *  importable without booting the HTTP server. */
export interface ParsedPresetFile {
  name: string
  personas: PresetPersona[]
  handoffGates?: HandoffGate[]
}

/** Validate a preset DOCUMENT — a team composed outside any live room (TUI
 *  composer, site builder, or an orchestrator-authored team spec). Unlike
 *  `parsePersona`, which silently drops unknown tools, every problem here is a
 *  thrown Error with the persona named in the message: a generated preset must
 *  be rejected loudly enough that the author (human or LLM) can read the
 *  reason and fix the document.
 *
 *  Field semantics follow the hydration contract (preset-hydration.ts):
 *  systemPrompt/skills ABSENT means "inherit from seed", so empty strings are
 *  dropped rather than stored — but an explicit `skills: []` is a real opt-out
 *  and survives. Returns non-blocking `warnings` alongside the parsed preset
 *  (e.g. several parallel personas pinned to the sequential local backend). */
export function parsePresetFile(rawName: string, body: unknown): { preset: ParsedPresetFile; warnings: PresetWarning[] } {
  const name = String(rawName ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "")
  if (!name) throw new Error("preset name must contain at least one of [a-zA-Z0-9_-]")
  if (!body || typeof body !== "object") throw new Error("request body must be a preset object")
  const doc = body as Record<string, unknown>

  if (!Array.isArray(doc.personas) || doc.personas.length === 0) {
    throw new Error("`personas` must be a non-empty array")
  }

  const personas: PresetPersona[] = []
  const seen = new Set<string>()
  for (const [i, raw] of doc.personas.entries()) {
    if (!raw || typeof raw !== "object") throw new Error(`personas[${i}] must be an object`)
    const p = raw as Record<string, unknown>
    const who = (extra: string) => `personas[${i}]${extra}`

    const pname = String(p.name ?? "").trim()
    if (!pname) throw new Error(who(".name is required"))
    const id = slug(String(p.id ?? pname))
    if (!id) throw new Error(who(`: could not derive a valid id from "${String(p.id ?? pname)}"`))
    if (seen.has(id)) throw new Error(who(`: duplicate id "${id}"`))
    seen.add(id)

    let tools = ["read", "grep", "find", "ls"]
    if (p.tools !== undefined) {
      if (!Array.isArray(p.tools)) throw new Error(who(` ("${id}"): \`tools\` must be an array`))
      tools = p.tools.map(String)
      const unknown = tools.find((t) => !VALID_TOOLS.has(t))
      if (unknown) {
        throw new Error(who(` ("${id}"): unknown tool "${unknown}" — valid tools: ${[...VALID_TOOLS].join(", ")}`))
      }
    }

    if (p.thinkingLevel !== undefined && !THINKING_LEVELS.has(String(p.thinkingLevel))) {
      throw new Error(who(` ("${id}"): invalid thinkingLevel "${String(p.thinkingLevel)}" — one of: ${[...THINKING_LEVELS].join(", ")}`))
    }
    if (p.vision !== undefined && typeof p.vision !== "boolean") {
      throw new Error(who(` ("${id}"): \`vision\` must be a boolean`))
    }
    if (p.skills !== undefined && (!Array.isArray(p.skills) || p.skills.some((s) => typeof s !== "string" || !s.trim()))) {
      throw new Error(who(` ("${id}"): \`skills\` must be an array of non-empty strings`))
    }
    if (p.seat !== undefined && typeof p.seat !== "string") {
      throw new Error(who(` ("${id}"): \`seat\` must be a string (fused-seats id, docs/fused-seats.md)`))
    }

    const systemPrompt = String(p.systemPrompt ?? "").trim()
    const model = String(p.model ?? "").trim()
    const compaction = String(p.compactionInstructions ?? "").trim()

    personas.push({
      id,
      name: pname,
      color: String(p.color ?? "#888888"),
      icon: String(p.icon ?? "🤖"),
      tools,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(model ? { model } : {}),
      ...(p.thinkingLevel !== undefined ? { thinkingLevel: p.thinkingLevel as Persona["thinkingLevel"] } : {}),
      ...(compaction ? { compactionInstructions: compaction } : {}),
      ...(p.vision !== undefined ? { vision: p.vision as boolean } : {}),
      ...(p.skills !== undefined ? { skills: (p.skills as string[]).map((s) => s.trim()) } : {}),
      // Empty/blank seat is dropped, not stored — absent = singleton (the
      // pre-feature default), same normalization as systemPrompt/model.
      ...(typeof p.seat === "string" && p.seat.trim() ? { seat: p.seat.trim() } : {}),
      active: p.active === undefined ? true : Boolean(p.active),
      ...(p.parallel !== undefined ? { parallel: Boolean(p.parallel) } : {}),
    })
  }

  let handoffGates: HandoffGate[] | undefined
  if (doc.handoffGates !== undefined) {
    const gates = parseHandoffGates(doc.handoffGates)
    if (typeof gates === "string") throw new Error(gates)
    if (gates.length > 0) handoffGates = gates
  }

  const warnings: PresetWarning[] = []
  const parallelLocal = personas.filter((p) => p.parallel && p.model?.startsWith("local/"))
  if (parallelLocal.length >= 2) {
    warnings.push({
      message:
        `${parallelLocal.map((p) => `"${p.id}"`).join(", ")} are parallel but pinned to the local backend, ` +
        "which serves one request at a time — they will run sequentially",
    })
  }
  for (const g of handoffGates ?? []) {
    for (const ref of [g.from, g.via]) {
      if (!seen.has(ref)) {
        warnings.push({ message: `handoff gate references "${ref}", which is not a persona in this preset — the gate will be inert` })
      }
    }
  }
  // Fused seats: one seat = one modelRef (declared refs — resolution varies by
  // environment). A violating seat will DEFUSE at room load; warn at save time
  // so the author fixes the document instead of discovering it in a transcript.
  for (const w of validateSeatModels(personas, (p) => p.model).warnings) {
    warnings.push({ message: `${w} (the seat will defuse at room load)` })
  }

  return { preset: { name, personas, ...(handoffGates ? { handoffGates } : {}) }, warnings }
}
