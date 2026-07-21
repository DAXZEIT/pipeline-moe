import type { Message, RosterItem } from "./types.js"

/** A directed transition between two seats, derived from the live transcript. */
export type HandoffType = "handoff" | "route" | "hatswitch"

export interface HandoffNode {
  id: string
  name: string
  color: string
  icon: string
  /** Agent messages this seat authored (0 for the synthetic user node). */
  turns: number
}

export interface HandoffEdge {
  source: string
  target: string
  count: number
  /** Per-type breakdown; the dominant type drives the edge's colour. */
  types: Partial<Record<HandoffType, number>>
}

export interface HandoffGraph {
  nodes: HandoffNode[]
  edges: HandoffEdge[]
  total: number
}

/** Synthetic node id for the human — the source of `route` edges. */
export const USER_NODE = "user"

/** The dominant (most frequent) transition type on an edge. */
export function dominantType(edge: HandoffEdge): HandoffType {
  const entries = Object.entries(edge.types) as [HandoffType, number][]
  if (entries.length === 0) return "handoff"
  return entries.sort((a, b) => b[1] - a[1])[0][0]
}

/** One node in the temporal handoff trace. `type` is the transition that led
 *  INTO this step (absent on the first). */
export interface HandoffChainStep extends HandoffNode {
  type?: HandoffType
}

/**
 * The room's handoffs as an ordered chain — the actual sequence of who held
 * the turn: `user → planner → builder → tester → planner → auditor`. Unlike
 * {@link deriveHandoffGraph} (an aggregate), this preserves order, collapsing
 * only consecutive turns by the same speaker. Each step carries the type of
 * the hop that reached it (route / handoff / hat-switch), so a client can tint
 * the arrows by kind. The literal trace reads better in a terminal than a grid.
 */
export function deriveHandoffChain(messages: Message[], roster: RosterItem[]): HandoffChainStep[] {
  const byId = new Map(roster.map((r) => [r.id, r]))
  const seatOf = (id: string): string | undefined => byId.get(id)?.seat
  const info = (id: string, type?: HandoffType): HandoffChainStep => {
    if (id === USER_NODE) return { id, name: "You", color: "#8b5cf6", icon: "🧑", turns: 0, type }
    const r = byId.get(id)
    return { id, name: r?.name ?? id, color: r?.color ?? "#78716c", icon: r?.icon ?? "•", turns: 0, type }
  }

  const steps: HandoffChainStep[] = []
  let prev: string | undefined
  for (const m of messages) {
    let speaker: string
    if (m.author === USER_NODE) speaker = USER_NODE
    else if (!m.author || m.author === "system" || m.author === "shell") continue
    else speaker = m.author
    if (speaker === prev) continue // one node per unbroken run of a speaker

    // A hop INTO the user is the user retaking the floor, not a route/handoff/
    // hat-switch — leave it untyped. Only agent-bound hops carry a kind.
    let type: HandoffType | undefined
    if (prev !== undefined && speaker !== USER_NODE) {
      type = prev === USER_NODE
        ? "route"
        : seatOf(prev) !== undefined && seatOf(prev) === seatOf(speaker)
          ? "hatswitch"
          : "handoff"
    }
    steps.push(info(speaker, type))
    prev = speaker
  }
  return steps
}

/**
 * Derive the room's handoff graph from the live transcript.
 *
 * Two edge sources, matching what the transcript actually records:
 *  - `message.handoffTo` — the explicit routing decision of the handoff tool
 *    (agent → agent). Typed `hatswitch` when both hats share one fused `seat`
 *    (same context, an intra-seat hop), otherwise `handoff`.
 *  - a user message immediately followed by an agent turn — the human routing
 *    work in, typed `route`.
 *
 * Nodes are only the seats that actually participated, plus the user node when
 * it routed at least once; display fields come from the live roster, so a seat
 * renamed or recoloured mid-session shows its current identity.
 */
export function deriveHandoffGraph(messages: Message[], roster: RosterItem[]): HandoffGraph {
  const byId = new Map(roster.map((r) => [r.id, r]))
  const turns = new Map<string, number>()
  const edges = new Map<string, HandoffEdge>()
  const seen = new Set<string>()

  const seatOf = (id: string): string | undefined => byId.get(id)?.seat
  const addEdge = (source: string, target: string, type: HandoffType): void => {
    if (source === target) return
    seen.add(source)
    seen.add(target)
    const key = `${source}>${target}`
    let edge = edges.get(key)
    if (!edge) {
      edge = { source, target, count: 0, types: {} }
      edges.set(key, edge)
    }
    edge.count += 1
    edge.types[type] = (edge.types[type] ?? 0) + 1
  }

  let pendingUser = false
  for (const m of messages) {
    if (m.author === USER_NODE) {
      pendingUser = true
      continue
    }
    // Shell/system rows carry no agent authorship; skip without breaking a
    // pending user route (the real agent turn is still to come).
    if (!m.author || m.author === "system" || m.author === "shell") continue

    turns.set(m.author, (turns.get(m.author) ?? 0) + 1)
    seen.add(m.author)

    if (pendingUser) {
      addEdge(USER_NODE, m.author, "route")
      pendingUser = false
    }
    if (m.handoffTo) {
      const type = seatOf(m.author) !== undefined && seatOf(m.author) === seatOf(m.handoffTo)
        ? "hatswitch"
        : "handoff"
      addEdge(m.author, m.handoffTo, type)
    }
  }

  const nodes: HandoffNode[] = [...seen].map((id) => {
    if (id === USER_NODE) {
      return { id, name: "You", color: "#8b5cf6", icon: "🧑", turns: 0 }
    }
    const r = byId.get(id)
    return {
      id,
      name: r?.name ?? id,
      color: r?.color ?? "#78716c",
      icon: r?.icon ?? "•",
      turns: turns.get(id) ?? 0,
    }
  })

  const edgeList = [...edges.values()].sort((a, b) => b.count - a.count)
  const total = edgeList.reduce((sum, e) => sum + e.count, 0)
  return { nodes, edges: edgeList, total }
}
