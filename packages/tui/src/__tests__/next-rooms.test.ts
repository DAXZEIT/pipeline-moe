import { describe, expect, test } from "vitest"
import { nextRoomSlot } from "../next/rooms.js"

// Tab navigation. Small enough to read, and exactly the kind of arithmetic that
// silently loses a tab: the `+` slot lives past the end of the room list and the
// cycle has to wrap THROUGH it, not around it.

const ids = ["alpha", "beta", "gamma"]

describe("nextRoomSlot", () => {
  test("→ walks the rooms in order", () => {
    expect(nextRoomSlot(ids, "alpha", false, 1)).toEqual({ kind: "room", roomId: "beta" })
    expect(nextRoomSlot(ids, "beta", false, 1)).toEqual({ kind: "room", roomId: "gamma" })
  })

  test("→ off the last room selects the + slot, and again wraps to the first", () => {
    expect(nextRoomSlot(ids, "gamma", false, 1)).toEqual({ kind: "plus" })
    expect(nextRoomSlot(ids, "gamma", true, 1)).toEqual({ kind: "room", roomId: "alpha" })
  })

  test("← from the first room reaches the + slot, so it is reachable both ways", () => {
    expect(nextRoomSlot(ids, "alpha", false, -1)).toEqual({ kind: "plus" })
    expect(nextRoomSlot(ids, "alpha", true, -1)).toEqual({ kind: "room", roomId: "gamma" })
  })

  test("a room the list does not know about is treated as position 0", () => {
    // The strip and the store can disagree for one frame after a switch.
    expect(nextRoomSlot(ids, "ghost", false, 1)).toEqual({ kind: "room", roomId: "beta" })
  })

  test("a single room still cycles between it and the + slot", () => {
    expect(nextRoomSlot(["only"], "only", false, 1)).toEqual({ kind: "plus" })
    expect(nextRoomSlot(["only"], "only", true, 1)).toEqual({ kind: "room", roomId: "only" })
    expect(nextRoomSlot(["only"], "only", false, -1)).toEqual({ kind: "plus" })
  })

  test("no rooms at all leaves nothing but the + slot", () => {
    expect(nextRoomSlot([], "", false, 1)).toEqual({ kind: "plus" })
    expect(nextRoomSlot([], "", true, -1)).toEqual({ kind: "plus" })
  })

  test("a full cycle returns to where it started, in both directions", () => {
    for (const dir of [1, -1] as const) {
      let current = "alpha"
      let plus = false
      for (let i = 0; i < ids.length + 1; i++) {
        const slot = nextRoomSlot(ids, current, plus, dir)
        plus = slot.kind === "plus"
        if (slot.kind === "room") current = slot.roomId
      }
      expect({ current, plus }).toEqual({ current: "alpha", plus: false })
    }
  })
})
