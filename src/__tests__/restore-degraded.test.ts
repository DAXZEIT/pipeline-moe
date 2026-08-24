import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { resolve } from "node:path"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { RoomManager } from "../room-manager.js"
import { SseHub } from "../sse.js"
import { config } from "../config.js"
import type { ResolvedModel } from "../model.js"

// Review 2026-08-24, #11 — a room whose sshfs mount failed at boot used to be
// restored with an empty scope, which createRoom resolves to the SHARED
// pipeline workspace: the remote room came up live in a scope it was never
// meant to see. The fix refuses the restore; the room's on-disk data stays
// and it remains in listResumableRooms() for a manual resume that re-mounts.
// These tests mock sshfs so the mount failure is deterministic.

const mountState = vi.hoisted(() => ({
  fail: false,
  calls: [] as string[],
}))

vi.mock("../sshfs.js", () => ({
  mountSshfs: (roomId: string, target: string) => {
    mountState.calls.push(`${roomId}:${target}`)
    if (mountState.fail) return Promise.reject(new Error("ssh: unreachable (simulated)"))
    return Promise.resolve(`/tmp/mocked-mount-${roomId}`)
  },
  unmountSshfs: () => Promise.resolve(),
}))

function makeResolvedModel(): ResolvedModel {
  return {
    provider: "test",
    modelId: "test-model",
    modelRegistry: {
      getAll: () => [],
      getProviderAuthStatus: () => "unauthenticated",
      getProviderDisplayName: () => "test",
      refresh: () => {},
    },
  } as unknown as ResolvedModel
}

describe("restoreRooms with a failing sshfs mount (review 2026-08-24, #11)", () => {
  let manager: RoomManager
  let hub: SseHub
  let suiteTmp: string
  const realSessionsDir = config.sessionsDir

  beforeEach(() => {
    suiteTmp = mkdtempSync(resolve(tmpdir(), "restore-degraded-"))
    ;(config as { sessionsDir: string }).sessionsDir = suiteTmp
    hub = new SseHub(1)
    manager = new RoomManager(makeResolvedModel(), hub, new Set(), [])
    mountState.fail = false
    mountState.calls = []
  })

  afterEach(async () => {
    await manager.flushWrites()
    ;(config as { sessionsDir: string }).sessionsDir = realSessionsDir
    rmSync(suiteTmp, { recursive: true, force: true })
  })

  /** Seed sessions/<id>/meta.json the way saveRoomMeta persists it, so the
   *  skipped room has the durable data a resume would need. */
  function seedRoomData(roomId: string, name: string, sshTarget: string): void {
    const dir = resolve(suiteTmp, roomId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      resolve(dir, "meta.json"),
      JSON.stringify({ roomId, name, createdAt: Date.now(), workspaceDir: sshTarget }),
    )
  }

  function seedManifest(entries: unknown[]): void {
    writeFileSync(resolve(suiteTmp, "rooms.json"), JSON.stringify(entries))
  }

  test("mount failure: the room is NOT restored, not even onto the shared workspace", async () => {
    seedManifest([
      { roomId: "default", name: "main-room" },
      { roomId: "vps", name: "VPS", sshTarget: "alice@10.0.0.1:/srv" },
    ])
    seedRoomData("vps", "VPS", "alice@10.0.0.1:/srv")

    mountState.fail = true
    const captured = await manager.loadManifest()
    manager.createDefaultRoom()
    await manager.restoreRooms(captured)

    // The room is not live — neither mounted nor on the default scope.
    expect(manager.getRoom("vps")).toBeUndefined()
    // …but it is resumable, with its durable scope intact.
    const resumable = await manager.listResumableRooms()
    expect(resumable.map((r) => r.roomId)).toContain("vps")
    const vps = resumable.find((r) => r.roomId === "vps")!
    expect(vps.name).toBe("VPS")
    expect(vps.workspaceDir).toBe("alice@10.0.0.1:/srv")
  })

  test("mount failure is scoped to that room: the others still restore", async () => {
    seedManifest([
      { roomId: "default", name: "main-room" },
      { roomId: "vps", name: "VPS", sshTarget: "alice@10.0.0.1:/srv" },
      { roomId: "local", name: "Local" },
    ])
    seedRoomData("vps", "VPS", "alice@10.0.0.1:/srv")

    // Every attempted mount fails; only the vps room attempts one — the
    // non-sshfs room must still restore.
    mountState.fail = true
    const captured = await manager.loadManifest()
    manager.createDefaultRoom()
    await manager.restoreRooms(captured)

    expect(manager.getRoom("vps")).toBeUndefined()
    expect(manager.getRoom("local")).toBeDefined()
    expect(manager.getRoomDetails("local")!.name).toBe("Local")
  })

  test("mount success: the room restores as before (no regression in the happy path)", async () => {
    seedManifest([
      { roomId: "default", name: "main-room" },
      { roomId: "vps", name: "VPS", sshTarget: "alice@10.0.0.1:/srv" },
    ])

    mountState.fail = false
    const captured = await manager.loadManifest()
    manager.createDefaultRoom()
    await manager.restoreRooms(captured)

    expect(mountState.calls).toEqual(["vps:alice@10.0.0.1:/srv"])
    expect(manager.getRoom("vps")).toBeDefined()
    expect(manager.getRoomDetails("vps")!.workspaceDir).toBe("/tmp/mocked-mount-vps")
    // A live room is not in the resumable list.
    expect((await manager.listResumableRooms()).map((r) => r.roomId)).not.toContain("vps")
  })
})
