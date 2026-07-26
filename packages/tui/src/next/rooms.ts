// Which tab ←/→ lands on.
//
// Two lines of arithmetic that were inline in `App.tsx` and are worth pinning:
// the strip is `[room0 … roomN, +]`, the `+` is a CURSOR POSITION rather than a
// room, and the cycle wraps through it — so from the last room, → selects `+`,
// and → again comes back to the first room. Off by one here means either an
// unreachable `+` tab or a room you can never navigate to, and both are the kind
// of bug you only notice on the day you have four rooms open.

export type RoomSlot = { kind: "room"; roomId: string } | { kind: "plus" }

/** Where the cursor goes. `current` is ignored when `plusSelected` — the cursor
 *  is on the `+` slot then, not on a room. An empty room list leaves nothing but
 *  the `+`. */
export function nextRoomSlot(ids: string[], current: string, plusSelected: boolean, dir: -1 | 1): RoomSlot {
  const n = ids.length
  if (n === 0) return { kind: "plus" }
  const at = plusSelected ? n : Math.max(ids.indexOf(current), 0)
  const next = (at + dir + n + 1) % (n + 1)
  return next === n ? { kind: "plus" } : { kind: "room", roomId: ids[next]! }
}
