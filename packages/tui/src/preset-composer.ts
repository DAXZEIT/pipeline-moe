// Pure state helpers for the preset composer (/preset new|edit) — everything
// the PresetComposerOverlay needs that doesn't touch Ink, extracted for unit
// tests, same split as preset-picker.ts.

import type { PresetFile, PresetPersona } from "@pipeline-moe/client-core"

/** VALID_TOOLS (src/validation.ts) shown as the card's grouped chip rows.
 *  Grouping is presentation only — the server's allowlist stays flat — so a
 *  client-side constant is the whole story, same as AgentForm's ALL_TOOLS. */
export const TOOL_GROUPS: { label: string; tools: string[] }[] = [
  { label: "core", tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] },
  { label: "web", tools: ["web_search", "web_read", "youtube_transcript", "arxiv_search", "youcom_search"] },
  { label: "orch", tools: ["spawn_room", "check_room", "stop_room", "destroy_room", "answer_room"] },
]

export const DEFAULT_TOOLS = ["read", "grep", "find", "ls"]

/** Same palette as EditAgentForm — new members rotate through it so a fresh
 *  team doesn't come out monochrome. */
export const PALETTE = [
  "#6Fb3d2",
  "#5DCAA5",
  "#EF9F27",
  "#E06C75",
  "#C678DD",
  "#61AFEF",
  "#98C379",
  "#E5C07B",
  "#56B6C2",
  "#D19A66",
  "#F47FA4",
  "#888888",
]

/** Backspace one CODE POINT, not one UTF-16 unit — naive slice(0, -1) halves
 *  an emoji into a lone surrogate, which then round-trips to disk as "\ud83e"
 *  (found live: backspacing the 🤖 icon in the member card). */
export function backspaceText(v: string): string {
  return [...v].slice(0, -1).join("")
}

/** Mirrors the server's slug() (src/validation.ts) so the id previewed in the
 *  composer is the id the server will store. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** "scout" among {scout, scout-2} → "scout-3". */
export function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

export function blankMember(existing: PresetPersona[]): PresetPersona {
  const taken = new Set(existing.map((p) => p.id))
  const id = uniqueId("agent", taken)
  const suffix = id === "agent" ? "" : ` ${id.slice("agent-".length)}`
  return {
    id,
    name: `Agent${suffix}`,
    color: PALETTE[existing.length % PALETTE.length],
    icon: "🤖",
    tools: [...DEFAULT_TOOLS],
    active: true,
  }
}

export function duplicateMember(list: PresetPersona[], i: number): PresetPersona[] {
  const src = list[i]
  if (!src) return list
  const taken = new Set(list.map((p) => p.id))
  const copy: PresetPersona = { ...src, tools: [...src.tools], id: uniqueId(src.id, taken) }
  if (src.skills) copy.skills = [...src.skills]
  return [...list.slice(0, i + 1), copy, ...list.slice(i + 1)]
}

/** Move list[i] by delta (clamped). Returns the new list and the new index. */
export function moveMember(list: PresetPersona[], i: number, delta: number): { list: PresetPersona[]; index: number } {
  const j = Math.max(0, Math.min(list.length - 1, i + delta))
  if (j === i || !list[i]) return { list, index: i }
  const next = [...list]
  const [moved] = next.splice(i, 1)
  next.splice(j, 0, moved)
  return { list: next, index: j }
}

/** One-line team readout for the roster footer: composition first, then the
 *  first coverage hole — the mini version of the site builder's stats panel. */
export function teamStats(personas: PresetPersona[]): string {
  const active = personas.filter((p) => p.active)
  const parts = [`${personas.length} member${personas.length === 1 ? "" : "s"}`]
  const lanes = active.filter((p) => p.parallel).length
  if (lanes > 0) parts.push(`${lanes} parallel`)
  const inactive = personas.length - active.length
  if (inactive > 0) parts.push(`${inactive} inactive`)

  const has = (pred: (t: string) => boolean) => active.some((p) => p.tools.some(pred))
  const webTools = new Set(TOOL_GROUPS[1].tools)
  if (personas.length > 0) {
    if (!has((t) => t === "write" || t === "edit")) parts.push("⚠ nobody can write")
    else if (!has((t) => webTools.has(t))) parts.push("⚠ no web access")
  }
  return parts.join(" · ")
}

/** Cycle orders for the ←→ fields. `undefined` = inherit, always first so the
 *  default state is one keypress away in either direction. */
export const THINKING_CYCLE: (string | undefined)[] = [undefined, "off", "minimal", "low", "medium", "high", "xhigh"]
export const VISION_CYCLE: (boolean | undefined)[] = [undefined, true, false]

export function cycle<T>(order: readonly T[], current: T, delta: number): T {
  const i = order.findIndex((v) => v === current)
  const at = i === -1 ? 0 : i
  return order[(at + delta + order.length) % order.length]
}

export function visionLabel(v: boolean | undefined): string {
  return v === undefined ? "default (on)" : v ? "on" : "off"
}

/** A deep-enough copy that editing in the composer never mutates the source
 *  preset (the picker hands us the object it also renders). */
export function clonePersonas(personas: PresetPersona[]): PresetPersona[] {
  return personas.map((p) => ({
    ...p,
    tools: [...p.tools],
    ...(p.skills ? { skills: [...p.skills] } : {}),
  }))
}

export function toPresetFile(name: string, personas: PresetPersona[], source?: PresetFile): PresetFile {
  return {
    name,
    personas,
    // Gates survive a remix untouched — the composer doesn't edit them (yet).
    ...(source?.handoffGates?.length ? { handoffGates: source.handoffGates } : {}),
  }
}
