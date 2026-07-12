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
