import { describe, test, expect } from "vitest"
import { RoomManager } from "../room-manager.js"
import { SseHub } from "../sse.js"

// Minimal stub ResolvedModel — renameRoom never touches it.
const fakeResolved: any = { modelRegistry: { getAll: () => [] } }

describe("RoomManager.renameRoom", () => {
  test("renames an existing room and reflects in listRooms", () => {
    const mgr = new RoomManager(fakeResolved, new SseHub(), new Set(), [])
    mgr.createRoom("default", "Discussion 1")
    expect(mgr.renameRoom("default", "main-room")).toBe(true)
    const summary = mgr.listRooms().find((r) => r.roomId === "default")
    expect(summary?.name).toBe("main-room")
  })

  test("returns false for unknown room", () => {
    const mgr = new RoomManager(fakeResolved, new SseHub(), new Set(), [])
    expect(mgr.renameRoom("nope", "x")).toBe(false)
  })
})
