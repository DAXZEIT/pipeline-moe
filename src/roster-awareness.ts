// Roster awareness — the pure formatter behind "agents know who is in the
// room, and on what brain" (design: docs/roster-awareness.md).
//
// Agents were roster-blind: the handoff enum carries ids only, so the planner
// routed by role name and hoped — it could not apply "count backends" without
// knowing which members are local, and a brief written for an Opus member
// reads very differently from one written for a local 27B. This module renders
// the same facts the TUI header already shows the operator, for the agents:
// one line per active member — id, name, RESOLVED model with a local/cloud
// tag, a compact tool summary, vision, and (fused seats) which shared seat the
// member's context lives on.
//
// Vocabulary: "seat" here means the fused-seats shared context
// (docs/fused-seats.md), NOT a roster member — members/agents are what the
// lines describe. Seat annotations are the anti-re-derivation datum: a planner
// that KNOWS the tester already has the builder's context writes its dispatch
// accordingly ("verify the diff you just watched being written" instead of a
// re-brief).
//
// Deliberately excluded: system prompts (private per member), skills (already
// surfaced to their owner), costs (volatile — the local/cloud tag carries the
// decision-relevant bit). Informational only: handoff validity stays owned by
// the tool's live checks, gates by the registry — an agent reasoning from a
// stale block falls into the same correctable-error recovery as today.

export interface RosterMemberInfo {
  id: string
  name: string
  /** Resolved "provider/id" the member actually runs — persona pin or the room
   *  default already substituted by the caller. Null = unknown (no default
   *  resolved yet); rendered as "room default model". */
  modelRef: string | null
  tools: string[]
  vision?: boolean
  /** Fused seats: resolved seat id when the member shares a context with
   *  others. Undefined/equal-to-id → singleton, no annotation rendered. */
  seatId?: string
  /** Ids of the OTHER hats sharing this member's seat. */
  seatMates?: string[]
}

/** @deprecated pre-fused-seats name — "seat" now means a shared context. */
export type RosterSeatInfo = RosterMemberInfo

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
 *  (life). `self` marks the receiving agent's own line — a string for a
 *  singleton, or every hat of the receiving seat (a fused seat reads the
 *  block once, so ALL of its hats are "you"). */
export function describeRosterBlock(members: RosterMemberInfo[], self: string | string[]): string {
  const selfIds = new Set(typeof self === "string" ? [self] : self)
  const lines = members.map((m) => {
    const you = selfIds.has(m.id) ? " ← you" : ""
    const vision = m.vision ? " · vision" : ""
    const seat =
      m.seatId && m.seatMates && m.seatMates.length > 0
        ? ` — ${m.seatId} seat (shared context with ${m.seatMates.map((id) => `@${id}`).join(", ")})`
        : ""
    return `- @${m.id} (${m.name}) — ${modelLabel(m.modelRef)} — ${toolSummary(m.tools)}${vision}${seat}${you}`
  })
  return [
    "YOUR TEAM (live roster — changes arrive as roster_update notes):",
    ...lines,
    "Write for the member you address: a local model needs numbered, mechanically",
    "checkable instructions; a frontier member can take judgment calls. Route work",
    "only toward members whose tools can actually do it. Members sharing a seat",
    "already have each other's working context — skip the re-brief.",
  ].join("\n")
}
