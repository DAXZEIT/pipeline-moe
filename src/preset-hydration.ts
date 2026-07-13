// Preset persona hydration — the pure functions that reconcile a saved preset
// against the current SEED_PERSONAS. Extracted from server.ts so they can be
// unit-tested without booting the HTTP server (server.ts calls main() at import
// time). server.ts is the only production caller.
//
// The contract, in one sentence: seed-derived fields (systemPrompt, skills) are
// STRIPPED on save when they still match the seed and REHYDRATED on load when
// absent, so a preset never carries a stale copy of something the seed owns and
// automatically inherits a seed capability that did not exist — or grew — after
// the preset was saved.

import { SEED_PERSONAS } from "./personas.js"
import type { Persona, PersonaState } from "./types.js"

/** Runtime-only persona fields that a preset DOCUMENT never carries, so they
 *  must be dropped before a live roster is compared against a preset — else
 *  every room reads as drifted the moment an agent advances its cursor. */
const RUNTIME_ONLY_FIELDS = ["cursor"] as const

/** A persona as persisted in a preset file — systemPrompt is optional since
 *  seed personas rehydrate from SEED_PERSONAS at load time. */
export interface PresetPersona extends Omit<PersonaState, "systemPrompt"> {
  systemPrompt?: string
}

/** True when two skill lists are the same set (order-independent). Decides
 *  whether a preset's `skills` is an untouched copy of the seed's — strip it so
 *  it tracks future seed changes — or an explicit override to preserve. Two
 *  undefineds are "equal"; undefined vs a list (incl. `[]`) is not. */
function sameSkillSet(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  if (a.length !== b.length) return false
  const sb = new Set(b)
  return a.every((s) => sb.has(s))
}

/** Strip seed-owned fields from personas whose id matches a seed, so a saved
 *  preset does not freeze a stale copy of something the seed owns.
 *
 *  - `systemPrompt`: stripped UNCONDITIONALLY. NOTE: systemPrompt IS user-
 *    editable (PATCH /api/participants/:id), so a customized prompt on a
 *    seed-id persona is discarded on save and resets to the seed default on
 *    load — real (if narrow) data loss. Making it strip-if-identical, like
 *    `skills` below, is a product-semantics call (should a preset snapshot a
 *    customized prompt, or always reference the current built-in?) tracked as
 *    ROADMAP #6 — deliberately NOT changed here as a silent builder decision.
 *  - `skills`: stripped ONLY when identical to the seed. An untouched copy
 *    becomes absent on disk, so it rehydrates to the CURRENT seed on every load
 *    and picks up future seed skills (permanent anti-drift, the property the
 *    unconditional keep did NOT have — it self-healed once, then re-froze). An
 *    explicit override — a customized list OR an empty `[]` opt-out — differs
 *    from the seed and is preserved untouched. */
export function stripSeedFields(
  personas: (PersonaState | PresetPersona)[],
  seedPersonas: readonly Persona[] = SEED_PERSONAS,
): PresetPersona[] {
  const seedMap = new Map(seedPersonas.map((p) => [p.id, p]))
  return personas.map((p) => {
    const seed = seedMap.get(p.id)
    if (!seed) return p as PresetPersona
    const { systemPrompt: _drop, ...rest } = p
    const out = rest as PresetPersona
    if (out.skills !== undefined && sameSkillSet(out.skills, seed.skills)) {
      const { skills: _skills, ...noSkills } = out
      return noSkills as PresetPersona
    }
    return out
  })
}

/** Rehydrate seed-derived fields (systemPrompt, skills) from SEED_PERSONAS for
 *  personas that share a seed id and OMIT the field.
 *  Semantics: a field ABSENT from the preset means "not specified" → inherit
 *  the current seed value, so a preset saved before a capability existed picks
 *  it up automatically (this is how the orchestrator skill reaches a planner in
 *  a pre-feature preset). A field PRESENT — even empty, e.g. `skills: []` — is
 *  an explicit override and is left untouched. Paired with `stripSeedFields`,
 *  which drops seed-identical fields on save, this makes inheritance permanent
 *  rather than one-shot: an unmodified field is always absent on disk, so it
 *  always rehydrates to whatever the seed currently is.
 *  NB: inherit-on-absent applies ONLY to systemPrompt and skills. `tools` is
 *  deliberately NOT rehydrated: presets specify tools explicitly and
 *  intentionally diverge from the seed (e.g. a planner granted write/edit for
 *  in-room file work), so silent inheritance would violate that intent — and it
 *  could not fix a present-but-incomplete list anyway. Tool additions stay a
 *  manual preset edit. */
/** Order-independent, key-stable canonical form of a value, so two personas
 *  that differ only in object-key or skills-array ORDER compare equal. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj).sort()) out[k] = canonicalize(obj[k])
    return out
  }
  return value
}

/** Stable signature of a single persona for drift comparison: seed-owned fields
 *  stripped (so a seed-inherited roster matches the stripped preset on disk),
 *  runtime-only fields dropped, skills order-normalized, keys sorted. */
function personaSignature(p: PresetPersona): string {
  const clone = { ...p } as Record<string, unknown>
  for (const f of RUNTIME_ONLY_FIELDS) delete clone[f]
  if (Array.isArray(clone.skills)) clone.skills = [...(clone.skills as string[])].sort()
  return JSON.stringify(canonicalize(clone))
}

/** True when the LIVE roster deviates from the preset DOCUMENT it was born from.
 *
 *  Both sides are normalized through `stripSeedFields` first — this is the
 *  anti-false-positive invariant the whole feature turns on: a roster loaded
 *  from a preset and never edited strips back to exactly the on-disk document,
 *  so a pure seed inheritance reads as ZERO drift. Only a real edit (fused
 *  seat, swapped model, added/removed agent, toggled active) moves a signature.
 *
 *  Comparison is by persona id, order-independent. A differing id SET (agent
 *  added or removed) is drift; a differing signature for a shared id is drift. */
export function rosterDeviatesFromPreset(
  current: (PersonaState | PresetPersona)[],
  preset: (PersonaState | PresetPersona)[],
  seedPersonas: readonly Persona[] = SEED_PERSONAS,
): boolean {
  const sign = (list: (PersonaState | PresetPersona)[]): Map<string, string> => {
    const map = new Map<string, string>()
    for (const p of stripSeedFields(list, seedPersonas)) map.set(p.id, personaSignature(p))
    return map
  }
  const a = sign(current)
  const b = sign(preset)
  if (a.size !== b.size) return true
  for (const [id, sig] of a) {
    if (b.get(id) !== sig) return true
  }
  return false
}

export function rehydrateSeedFields(
  personas: PresetPersona[],
  seedPersonas: readonly Persona[] = SEED_PERSONAS,
): PersonaState[] {
  const seedMap = new Map(seedPersonas.map((p) => [p.id, p]))
  return personas.map((p) => {
    const seed = seedMap.get(p.id)
    if (!seed) return p as PersonaState
    const merged = { ...p } as PersonaState
    if (!p.systemPrompt) merged.systemPrompt = seed.systemPrompt
    if (p.skills === undefined && seed.skills !== undefined) {
      merged.skills = seed.skills
    }
    return merged
  })
}
