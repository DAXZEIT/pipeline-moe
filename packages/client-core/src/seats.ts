// Fused-seats display helpers shared by the TUI strip and the web roster.

import type { RosterItem } from "./types.js"

/** Stable-group same-seat members contiguously: the first member of a seat
 *  anchors its group, mates pull up behind it, everything else keeps roster
 *  order. The server keeps fused hats adjacent nowadays (reseat reorders),
 *  but a roster persisted before that fix, a manual drag, or an older server
 *  can still deliver a scattered seat — the UIs group by ADJACENCY, so they
 *  normalize here instead of trusting the wire order. */
export function groupBySeat(roster: RosterItem[]): RosterItem[] {
  const out: RosterItem[] = []
  const done = new Set<string>()
  for (const r of roster) {
    if (done.has(r.id)) continue
    if (r.seat) {
      for (const mate of roster) {
        if (mate.seat === r.seat && !done.has(mate.id)) {
          out.push(mate)
          done.add(mate.id)
        }
      }
    } else {
      out.push(r)
      done.add(r.id)
    }
  }
  return out
}

/** Same declared-model comparison the server's invariant uses:
 *  undefined on both sides = both on the host default = compatible. */
export function modelsDiffer(a: RosterItem, b: RosterItem): boolean {
  return (a.model ?? null) !== (b.model ?? null)
}

/** One-seat-one-model invariant: the seat already carries a single declared
 *  model (or the host default), so a joining hat is compatible iff it shares
 *  that declared model. Undefined-vs-undefined is compatible (both default).
 *  Pure — the server's own check before mutation uses the same comparison.
 *  Undefined means the hat is not fused yet — no seat to join. */
export interface SeatJoin {
  seat: string
  /** The other hats already on this seat — the joining agent is not included. */
  hats: RosterItem[]
  /** Joining would mix declared models — the server refuses with a loud notice,
   *  but the action is left clickable (not disabled) so the refusal teaches.
   *  See docs/fused-seats.md for the one-seat-one-modelRef invariant. */
  mismatch: boolean
}

export interface SeatPair {
  partner: RosterItem
  /** Same mismatch semantics as SeatJoin — shared a NEW, named seat. */
  mismatch: boolean
}

/** Pure seat-move enumeration shared by the TUI seat menu and the web roster
 *  menu: the join/pair/detach logic lives here, each client only renders. */
export function seatMoves(agent: RosterItem, roster: RosterItem[]): {
  joins: SeatJoin[]
  pairs: SeatPair[]
  canDetach: boolean
} {
  // Fused seats OTHER than the agent's own — "join" targets.
  const fused = new Map<string, RosterItem[]>()
  for (const p of roster) {
    if (p.seat && p.seat !== agent.seat && p.id !== agent.id)
      fused.set(p.seat, [...(fused.get(p.seat) ?? []), p])
  }
  const joins: SeatJoin[] = []
  for (const [seat, hats] of fused) {
    joins.push({
      seat,
      hats,
      mismatch: hats.some((h) => modelsDiffer(agent, h)),
    })
  }

  // Own-context peers — "share a new seat with" targets.
  const pairs: SeatPair[] = []
  for (const p of roster) {
    if (p.id === agent.id || p.seat) continue
    pairs.push({ partner: p, mismatch: modelsDiffer(agent, p) })
  }

  return {
    joins,
    pairs,
    canDetach: agent.seat != null,
  }
}
