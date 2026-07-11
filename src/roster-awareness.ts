// Roster awareness — the pure formatter behind "agents know who is in the
// room, and on what brain" (design: docs/roster-awareness.md).
//
// Agents were roster-blind: the handoff enum carries ids only, so the planner
// routed by role name and hoped — it could not apply "count backends" without
// knowing which seats are local, and a brief written for an Opus seat reads
// very differently from one written for a local 27B. This module renders the
// same facts the TUI header already shows the operator, for the agents:
// one line per active seat — id, name, RESOLVED model with a local/cloud tag,
// a compact tool summary, vision.
//
// Deliberately excluded: system prompts (private per seat), skills (already
// surfaced to their owner), costs (volatile — the local/cloud tag carries the
// decision-relevant bit). Informational only: handoff validity stays owned by
// the tool's live checks, gates by the registry — an agent reasoning from a
// stale block falls into the same correctable-error recovery as today.

export interface RosterSeatInfo {
  id: string
  name: string
  /** Resolved "provider/id" the seat actually runs — persona pin or the room
   *  default already substituted by the caller. Null = unknown (no default
   *  resolved yet); rendered as "room default model". */
  modelRef: string | null
  tools: string[]
  vision?: boolean
}

/** "anthropic/claude-opus-4-8 [cloud]" · "Qwopus3.6-27B-v2 [local GPU]".
 *  The tag, not the raw ref, is what capability/backend reasoning needs. */
export function modelLabel(ref: string | null): string {
  if (!ref) return "room default model"
  if (ref.startsWith("local/")) {
    const file = ref.slice("local/".length).replace(/\.gguf$/i, "")
    return `${file} [local GPU]`
  }
  return `${ref} [cloud]`
}

const WEB_TOOLS = new Set(["web_search", "web_read", "youcom_search", "youtube_transcript", "arxiv_search"])
const READ_TOOLS = new Set(["read", "grep", "find", "ls"])

/** Compact capability summary from a persona's tool allowlist. Examples over
 *  the seed roster: planner "read-only + orchestration" · builder
 *  "read/write/edit/bash" · auditor "read-only" · scout "read/web". */
export function toolSummary(tools: string[]): string {
  const has = (t: string) => tools.includes(t)
  const web = tools.some((t) => WEB_TOOLS.has(t))
  const orchestration = has("spawn_room")
  const mutating: string[] = []
  if (has("write")) mutating.push("write")
  if (has("edit")) mutating.push("edit")
  if (has("bash")) mutating.push("bash")

  let base: string
  if (mutating.length === 0) {
    base = "read-only"
    if (web) base += " + web"
  } else {
    const parts: string[] = []
    if (tools.some((t) => READ_TOOLS.has(t))) parts.push("read")
    parts.push(...mutating)
    if (web) parts.push("web")
    base = parts.join("/")
  }
  return orchestration ? `${base} + orchestration` : base
}

/** The block injected into system prompts (birth) and roster_update messages
 *  (life). `selfId` marks the receiving agent's own line. */
export function describeRosterBlock(seats: RosterSeatInfo[], selfId: string): string {
  const lines = seats.map((s) => {
    const you = s.id === selfId ? " ← you" : ""
    const vision = s.vision ? " · vision" : ""
    return `- @${s.id} (${s.name}) — ${modelLabel(s.modelRef)} — ${toolSummary(s.tools)}${vision}${you}`
  })
  return [
    "YOUR TEAM (live roster — changes arrive as roster_update notes):",
    ...lines,
    "Write for the seat you address: a local model needs numbered, mechanically",
    "checkable instructions; a frontier seat can take judgment calls. Route work",
    "only toward seats whose tools can actually do it.",
  ].join("\n")
}
