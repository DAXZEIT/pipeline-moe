import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { resolve } from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { RoomManager } from "../room-manager.js"
import { SseHub } from "../sse.js"
import { config } from "../config.js"

// Minimal stub ResolvedModel — renameRoom never touches it.
const fakeResolved: any = { modelRegistry: { getAll: () => [] } }

describe("RoomManager.renameRoom", () => {
  // createRoom/renameRoom now fire-and-forget write the manifest — keep it off
  // the real sessions/ dir.
  let suiteTmp: string
  const realSessionsDir = config.sessionsDir

  beforeEach(() => {
    suiteTmp = mkdtempSync(resolve(tmpdir(), "room-rename-"))
    ;(config as { sessionsDir: string }).sessionsDir = suiteTmp
  })

  afterEach(() => {
    ;(config as { sessionsDir: string }).sessionsDir = realSessionsDir
    rmSync(suiteTmp, { recursive: true, force: true })
  })

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
