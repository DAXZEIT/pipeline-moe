// Fused seats (docs/fused-seats.md) — pure helpers for the seat layer.
//
// The persona is a HAT (role prompt + tool allowlist, applied per turn); the
// context is a SEAT (one pi session shared by a cluster of hats). This module
// is deliberately pure — no I/O, no session objects: persona→seat resolution,
// seat prompt assembly, hat headers, the execution-time tool gate, compaction
// unions and hat-switch trace suffixes. The stateful lifecycle (the Seat that
// OWNS the pi session, refcounted kick, flush) lives with the session code;
// everything it decides with is computed here, unit-testable.
//
// Vocabulary note: elsewhere in this codebase "seat" historically meant
// "roster member". In this module and everywhere it reaches, a seat is a
// shared context and a hat is a role — old usages migrate to member/agent
// opportunistically (glossary in docs/fused-seats.md).

import type { Persona } from "./types.js"

/** The slice of a Persona the seat layer needs. Accepting the slice keeps the
 *  helpers usable on PersonaState and test literals alike. */
export type HatLike = Pick<Persona, "id" | "seat" | "tools"> &
  Partial<Pick<Persona, "systemPrompt" | "compactionInstructions" | "model">>

/** Seat id a persona resolves to. Absent/blank `seat` = the persona is its
 *  own singleton seat — the pre-feature behavior, byte for byte. Naming your
 *  seat after another persona's id deliberately fuses with that singleton. */
export function seatIdOf(p: Pick<Persona, "id" | "seat">): string {
  const s = p.seat?.trim()
  return s ? s : p.id
}

/** Group personas by resolved seat, preserving roster insertion order both
 *  across seats and within a seat (the seat prompt's section order). */
export function clusterBySeat<P extends Pick<Persona, "id" | "seat">>(personas: P[]): Map<string, P[]> {
  const clusters = new Map<string, P[]>()
  for (const p of personas) {
    const seat = seatIdOf(p)
    const cluster = clusters.get(seat)
    if (cluster) cluster.push(p)
    else clusters.set(seat, [p])
  }
  return clusters
}

/** One-seat-one-modelRef invariant (ROADMAP: décisions actées, grilling Q9c).
 *  A shared session has ONE cache prefix and one per-turn budget resolution —
 *  hats pinning different models on the same seat would silently destroy the
 *  prefix-cache win and mislabel the reasoning budget. Violations DEFUSE the
 *  whole seat (every hat falls back to its singleton) rather than electing an
 *  arbitrary winner, and the caller is handed loud warnings to surface.
 *  `refOf` resolves a persona to its effective "provider/id" (undefined =
 *  the process default, which is a valid shared value). */
export function validateSeatModels<P extends Pick<Persona, "id" | "seat" | "model">>(
  personas: P[],
  refOf: (p: P) => string | undefined,
): { warnings: string[]; defused: Set<string> } {
  const warnings: string[] = []
  const defused = new Set<string>()
  for (const [seat, hats] of clusterBySeat(personas)) {
    if (hats.length < 2) continue
    const refs = new Map<string, string[]>()
    for (const h of hats) {
      const ref = refOf(h) ?? "(process default)"
      const ids = refs.get(ref)
      if (ids) ids.push(h.id)
      else refs.set(ref, [h.id])
    }
    if (refs.size > 1) {
      const detail = [...refs.entries()].map(([ref, ids]) => `${ids.join("+")} → ${ref}`).join(", ")
      warnings.push(
        `seat "${seat}" mixes models (${detail}) — a seat is one session with one cache prefix. ` +
          `Defused: each of ${hats.map((h) => h.id).join(", ")} keeps its own context (seat == persona).`,
      )
      defused.add(seat)
    }
  }
  return { warnings, defused }
}

/** Union of the hats' tool allowlists, first-seen order. This is the seat
 *  session's CONSTANT toolset: swapping schemas per turn would re-template the
 *  tools block and evict the llama-server prefix cache — the gate below
 *  restricts at execution time instead (docs/fused-seats.md §2). */
export function unionTools(hats: Array<Pick<Persona, "tools">>): string[] {
  const seen = new Set<string>()
  const union: string[] = []
  for (const h of hats) {
    for (const t of h.tools) {
      if (!seen.has(t)) {
        seen.add(t)
        union.push(t)
      }
    }
  }
  return union
}

/** Execution-time tool gate for a shared seat (décision actée: allowlist gate
 *  is dynamic, against the CURRENT hat). Returns a correctable error message
 *  when the tool belongs to another hat of the seat, null when allowed.
 *  Tools absent from every hat's allowlist are context-granted room primitives
 *  (handoff, task_*, ask_orchestrator) — never gated here. Hat blur therefore
 *  degrades into a refused call the model can route around, never into
 *  unauthorized action and never into losing a coordination primitive. */
export function hatToolGate(
  hats: Array<Pick<Persona, "id" | "tools">>,
  currentHat: () => string,
): (toolName: string) => string | null {
  return (toolName: string) => {
    const active = currentHat()
    const self = hats.find((h) => h.id === active)
    if (!self || self.tools.includes(toolName)) return null
    const owners = hats.filter((h) => h.tools.includes(toolName)).map((h) => h.id)
    if (owners.length === 0) return null
    return (
      `The ${toolName} tool belongs to the ${owners.join("/")} hat of this seat. ` +
      `This turn wears the ${active} hat — finish with your hands (${self.tools.join(", ") || "none"}), ` +
      `or hand off to ${owners.map((o) => `@${o}`).join(" or ")} to switch hats.`
    )
  }
}

/** Labeled union of the hats' compaction instructions (décision actée). A
 *  single hat keeps its instructions verbatim (byte-compat with today); a
 *  fused seat gets each hat's instructions scoped to ITS work, so one hat's
 *  "Discard …" never throws away another hat's living state. */
export function seatCompactionInstructions(
  hats: Array<Pick<Persona, "id" | "compactionInstructions">>,
): string | undefined {
  const withInstructions = hats.filter((h) => h.compactionInstructions?.trim())
  if (withInstructions.length === 0) return undefined
  if (hats.length === 1) return hats[0].compactionInstructions
  return withInstructions
    .map((h) => `For the ${h.id} hat's work: ${h.compactionInstructions!.trim()}`)
    .join("\n")
}

/** Longest common prefix of the given strings, cut back to the last newline
 *  boundary so factoring never splits a sentence. Seed personas share
 *  BASE_PROMPT verbatim, so factoring recovers it exactly; custom personas
 *  factor whatever they genuinely share (possibly nothing). */
export function commonPromptPrefix(prompts: string[]): string {
  if (prompts.length === 0) return ""
  let prefix = prompts[0]
  for (const p of prompts.slice(1)) {
    let i = 0
    const max = Math.min(prefix.length, p.length)
    while (i < max && prefix[i] === p[i]) i++
    prefix = prefix.slice(0, i)
    if (prefix === "") return ""
  }
  const cut = prefix.lastIndexOf("\n")
  return cut === -1 ? "" : prefix.slice(0, cut + 1)
}

/** A hat plus the logbook content to inline in its section (already read and
 *  capped by the caller — this module does no I/O). */
export interface HatSection {
  persona: Pick<Persona, "id" | "name" | "tools" | "systemPrompt">
  /** Contents of agent_memory/<id>.md, if any. */
  logbook?: string
}

/** The seat's system prompt body — the multi-role, ADDITIVE replacement for a
 *  single persona.systemPrompt (décision actée, grilling Q3: assignment
 *  framing + one titled section per hat; the per-turn hat header only points
 *  here). Shared prompt prefix across hats (BASE_PROMPT for seed personas) is
 *  factored out once; each section carries the hat's remainder, its hands,
 *  and its logbook — visible to every hat of the seat: the working context is
 *  already shared, and lessons belong to the office, not the occupant. */
export function buildSeatSystemPrompt(seatId: string, sections: HatSection[]): string {
  const prompts = sections.map((s) => s.persona.systemPrompt)
  const shared = commonPromptPrefix(prompts)
  const parts: string[] = []
  parts.push(
    `SEAT ASSIGNMENT — you hold the "${seatId}" seat.\n` +
      `You currently have the roles ${sections.map((s) => s.persona.id).join(", ")} in this seat: one shared ` +
      `working context, several hats. Each turn arrives wearing exactly ONE hat, named in the hat header at the ` +
      `top of the turn. The duties below attach to the seat, not to pride of authorship — work you watched being ` +
      `done from another hat is work you may judge, extend or hand off; the seat's memory of it is real and yours ` +
      `to use. Wear the named hat's duties and hands for the whole turn.`,
  )
  if (shared) {
    parts.push(`Shared foundation for every hat of this seat:\n${shared.trimEnd()}`)
  }
  for (const s of sections) {
    const remainder = s.persona.systemPrompt.slice(shared.length).trim()
    const lines = [
      `## ${s.persona.id} hat (${s.persona.name})`,
      remainder,
      `Hands of this hat: ${s.persona.tools.length > 0 ? s.persona.tools.join(", ") : "none"}.`,
    ]
    if (s.logbook?.trim()) {
      lines.push(`### ${s.persona.id} hat logbook (agent_memory/${s.persona.id}.md — written by the greffier, lessons belong to the office):\n${s.logbook.trim()}`)
    }
    parts.push(lines.filter(Boolean).join("\n"))
  }
  return parts.join("\n\n")
}

/** The per-turn hat header — the thin switch (décision actée: ≤ ~400 chars,
 *  assignment language, zero lessons, zero file reads; it points at the hat's
 *  section in the seat prompt). Prefixed to the turn prompt so the hat is part
 *  of the turn atomically, same channel family as roster_update notes. */
export function buildHatHeader(
  hat: Pick<Persona, "id" | "tools">,
  seatId: string,
  hats: Array<Pick<Persona, "id" | "tools">>,
): string {
  const others = hats.filter((h) => h.id !== hat.id).map((h) => h.id)
  const hands = hat.tools.length > 0 ? hat.tools.join(", ") : "none — coordinate via handoff"
  return (
    `[${seatId} seat — ${hat.id} hat] This turn you wear the ${hat.id} hat ` +
    `(duties: the "${hat.id} hat" section of your system prompt). ` +
    `Hands this turn: ${hands}. ` +
    `Other hats of this seat (${others.join(", ")}) keep their own tools — hand off to switch hats.`
  )
}

/** Trace suffix for an intra-seat handoff (décision actée: no new glyph — the
 *  glyph encodes decision authority, unchanged; the suffix states the
 *  cause-neutral topological fact). Grep anchor for the re-derivation metric:
 *  `grep "hat switch"` over session jsonl. Empty when the hop crosses seats. */
export function hatSwitchSuffix(fromId: string, toId: string, seatOf: (id: string) => string): string {
  if (fromId === toId) return ""
  const seat = seatOf(fromId)
  return seat === seatOf(toId) ? ` — hat switch (${seat} seat, context carried)` : ""
}
