import { Type } from "typebox"
import { Value } from "typebox/value"

/* ── Types ──────────────────────────────────────────────────────────── */

/** Per-agent thinking/effort level. Undefined → inherit from global config. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"

export interface HandoffGate {
  /** Agent id the gate applies to. */
  from: string
  /** Required handoff target while armed. */
  via: string
  /** Workspace-relative glob patterns that arm the gate. Omitted → armed on every handoff. */
  when?: string[]
}

/** A persona as persisted in a preset file. */
export interface PresetPersona {
  id: string
  name: string
  color: string
  icon: string
  tools: string[]
  /** User-visible prompt instructions. Optional — seed personas rehydrate from the server seed. */
  systemPrompt?: string
  model?: string
  thinkingLevel?: ThinkingLevel
  compactionInstructions?: string
  /** Whether the agent receives image attachments. */
  vision?: boolean
  /** Agent Skills granted, by directory name. */
  skills?: string[]
  /** Fused seats: id of the shared context. */
  seat?: string
  /** Whether the persona is active in the roster. */
  active: boolean
  /** May run concurrently with adjacent parallel-flagged agents. */
  parallel?: boolean
  /** Index of the next unseen transcript entry (integer — runtime-validated
   *  as `Type.Integer`, though the TS type is the wider `number`). Runtime
   *  field that leaks into saved files. */
  cursor?: number
}

export interface PresetFile {
  name: string
  personas: PresetPersona[]
  handoffGates?: HandoffGate[]
}

/** A single validation error with a JSON-Path-style location and human message. */
export interface TypedError {
  path: string
  message: string
}

export type ValidationResult =
  | { ok: true; value: PresetFile }
  | { ok: false; errors: TypedError[] }

/* ── TypeBox schema (non-transforming validation + native JSON Schema) */

const handoffGateType = Type.Object(
  {
    from: Type.String(),
    via: Type.String(),
    when: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
)

const personaType = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    color: Type.String(),
    icon: Type.String(),
    tools: Type.Array(Type.String()),
    systemPrompt: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    thinkingLevel: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
      ]),
    ),
    compactionInstructions: Type.Optional(Type.String()),
    vision: Type.Optional(Type.Boolean()),
    skills: Type.Optional(Type.Array(Type.String())),
    seat: Type.Optional(Type.String()),
    active: Type.Boolean(),
    parallel: Type.Optional(Type.Boolean()),
    cursor: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
)

/** The TypeBox schema — itself a valid JSON Schema object (plus internal symbols). */
export const presetSchema = Type.Object(
  {
    name: Type.String(),
    personas: Type.Array(personaType, { minItems: 1 }),
    handoffGates: Type.Optional(Type.Array(handoffGateType)),
  },
  { additionalProperties: false },
)

/* ── Non-transforming validator ────────────────────────────────────── */

/** Validate a parsed preset document against the schema.
 *
 *  CONTRACT: never transforms the input — `Value.Check` is a pure predicate,
 *  the input object (with its original insertion order) is returned typed.
 *  The identity contract is guarded in validate.test.ts; the gate test asserts
 *  ACCEPTANCE over the real preset files, and a negative control asserts
 *  rejection of in-memory corruptions (see docs/preset-schema.md). Never replicate the
 *  server's `parsePresetFile` trims/drops here (empty systemPrompt, blank seat).
 */
export function validatePreset(input: unknown): ValidationResult {
  if (!Value.Check(presetSchema, input)) {
    const errors: TypedError[] = []
    for (const raw of Value.Errors(presetSchema, input)) {
      const e = raw as {
        instancePath: string
        keyword: string
        params: Record<string, unknown>
        message: string
      }
      const names =
        e.keyword === "additionalProperties"
          ? (e.params.additionalProperties as string[])
          : e.keyword === "required"
            ? (e.params.requiredProperties as string[])
            : []
      if (names.length > 0) {
        for (const n of names) errors.push({ path: `${e.instancePath}/${n}`, message: e.message })
      } else {
        errors.push({ path: e.instancePath, message: e.message })
      }
    }
    return { ok: false, errors }
  }
  return { ok: true, value: input as PresetFile }
}

/* ── JSON Schema export ────────────────────────────────────────────── */

/** A plain JSON Schema object (TypeBox's internal Symbol markers stripped).
 *  Use for schema consumption outside the TypeBox ecosystem (OpenAPI, site/). */
export const presetJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  ...JSON.parse(JSON.stringify(presetSchema)),
} as object
