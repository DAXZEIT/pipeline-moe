import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { resolve } from "node:path"
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { RoomManager } from "../room-manager.js"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
import { config } from "../config.js"
import type { ResolvedModel } from "../model.js"

// ── Minimal stub for ResolvedModel ──────────────────────────────────────────

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
    // Add other required fields as undefined — tests don't call model inference
  } as unknown as ResolvedModel
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("RoomManager", () => {
  let hub: SseHub
  let manager: RoomManager
  let suiteTmp: string
  const realSessionsDir = config.sessionsDir

  beforeEach(() => {
    // Redirect the manifest away from the real sessions/ dir: createRoom now
    // fire-and-forget writes rooms.json, and no test should pollute real state.
    suiteTmp = mkdtempSync(resolve(tmpdir(), "room-suite-"))
    ;(config as { sessionsDir: string }).sessionsDir = suiteTmp
    hub = new SseHub(1)
    manager = new RoomManager(makeResolvedModel(), hub, new Set(), [])
  })

  afterEach(() => {
    ;(config as { sessionsDir: string }).sessionsDir = realSessionsDir
    rmSync(suiteTmp, { recursive: true, force: true })
  })

  test("createDefaultRoom returns a Room with roomId 'default'", () => {
    const room = manager.createDefaultRoom()
    expect(room).toBeInstanceOf(Room)
    expect(room.roomId).toBe("default")
  })

  test("getRoom returns the default room after createDefaultRoom", () => {
    const room = manager.createDefaultRoom()
    expect(manager.getRoom("default")).toBe(room)
  })

  test("getRoom returns undefined for unknown id", () => {
    manager.createDefaultRoom()
    expect(manager.getRoom("nonexistent")).toBeUndefined()
  })

  test("createRoom creates a room with the given id", () => {
    const room = manager.createRoom("cloud-sprint", "Cloud Sprint")
    expect(room).toBeInstanceOf(Room)
    expect(room.roomId).toBe("cloud-sprint")
    expect(manager.getRoom("cloud-sprint")).toBe(room)
  })

  test("createRoom throws when creating a duplicate room id", () => {
    manager.createDefaultRoom()
    expect(() => manager.createDefaultRoom()).toThrow('Room "default" already exists')
  })

  test("listRooms reflects created rooms", () => {
    manager.createDefaultRoom()
    manager.createRoom("room-2", "Second Room")

    const list = manager.listRooms()
    expect(list).toHaveLength(2)
    const ids = list.map((r) => r.roomId)
    expect(ids).toContain("default")
    expect(ids).toContain("room-2")
  })

  test("listRooms entry has roomId and name", () => {
    manager.createRoom("my-room", "My Room")
    const [entry] = manager.listRooms()
    expect(entry.roomId).toBe("my-room")
    expect(entry.name).toBe("My Room")
    expect(typeof entry.participantCount).toBe("number")
  })

  test("destroyRoom removes the room", async () => {
    manager.createDefaultRoom()
    expect(manager.getRoom("default")).toBeDefined()
    const removed = await manager.destroyRoom("default")
    expect(removed).toBe(true)
    expect(manager.getRoom("default")).toBeUndefined()
  })

  test("destroyRoom returns false for nonexistent room", async () => {
    expect(await manager.destroyRoom("ghost")).toBe(false)
  })

  test("destroyRoom aborts the room's in-flight pipeline before removal (no zombie)", async () => {
    // Regression guard: previously destroyRoom only deleted the Map entry, so a
    // busy room kept running headless — holding the local-model lock and writing
    // files. It must abort the pipeline first.
    const room = manager.createRoom("busy", "Busy")
    const spy = vi.spyOn(room, "abortCurrent")
    const removed = await manager.destroyRoom("busy")
    expect(removed).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(manager.getRoom("busy")).toBeUndefined()
  })

  test("each room has its own independent registry", () => {
    const r1 = manager.createRoom("room-a", "A")
    const r2 = manager.createRoom("room-b", "B")
    // Registries are separate instances
    expect(r1.getRegistry()).not.toBe(r2.getRegistry())
  })

  test("Room.roomId is accessible after creation", () => {
    const room = new Room({} as any, hub, {} as any, [], "my-room-id")
    expect(room.roomId).toBe("my-room-id")
  })

  test("Room.roomId defaults to 'default' when not specified", () => {
    const room = new Room({} as any, hub, {} as any, [])
    expect(room.roomId).toBe("default")
  })

  test("multiple rooms coexist with independent transcripts", async () => {
    const r1 = manager.createRoom("alpha", "Alpha")
    const r2 = manager.createRoom("beta", "Beta")

    // Both start with empty transcripts
    expect(r1.getTranscript()).toHaveLength(0)
    expect(r2.getTranscript()).toHaveLength(0)

    // Rooms are distinct objects
    expect(r1).not.toBe(r2)
  })

  test("destroying a room removes it from listing", async () => {
    manager.createRoom("temp", "Temp Room")
    expect(manager.listRooms()).toHaveLength(1)
    await manager.destroyRoom("temp")
    expect(manager.listRooms()).toHaveLength(0)
  })

  test("roomOf pattern: default room accessible when no roomId", () => {
    const defaultRoom = manager.createDefaultRoom()
    // Simulate what roomOf(req) does when req.params.roomId is missing
    const params: Record<string, string> = {}
    const roomId = params.roomId ?? "default"
    expect(manager.getRoom(roomId)).toBe(defaultRoom)
  })

  test("roomOf pattern: specific room accessible by id", () => {
    manager.createDefaultRoom()
    const specific = manager.createRoom("cloud-sprint", "Cloud Sprint")
    expect(manager.getRoom("cloud-sprint")).toBe(specific)
    expect(manager.getRoom("cloud-sprint")).not.toBe(manager.getRoom("default"))
  })

  test("createRoom without workspaceDir defaults to the pipeline workspace", () => {
    const room = manager.createRoom("scoped-default", "Default Scope")
    expect(room.getWorkspaceDir()).toBe(config.workspaceDir)
    expect(manager.getRoomDetails("scoped-default")!.workspaceDir).toBe(config.workspaceDir)
  })

  test("createRoom with a custom workspaceDir scopes the room to it (resolved absolute)", () => {
    const custom = "/tmp/pipeline-room-scope-test"
    const room = manager.createRoom("scoped-custom", "Custom Scope", undefined, custom)
    expect(room.getWorkspaceDir()).toBe(resolve(custom))
    expect(manager.getRoomDetails("scoped-custom")!.workspaceDir).toBe(resolve(custom))
  })

  test("createRoom resolves a relative workspaceDir against cwd", () => {
    const room = manager.createRoom("scoped-rel", "Relative Scope", undefined, "projects/foo")
    expect(room.getWorkspaceDir()).toBe(resolve("projects/foo"))
  })

  test("createRoom treats blank workspaceDir as the default workspace", () => {
    const room = manager.createRoom("scoped-blank", "Blank Scope", undefined, "   ")
    expect(room.getWorkspaceDir()).toBe(config.workspaceDir)
  })

  test("two rooms can hold independent workspace scopes", () => {
    const a = manager.createRoom("scope-a", "A", undefined, "/tmp/scope-a")
    const b = manager.createRoom("scope-b", "B", undefined, "/tmp/scope-b")
    expect(a.getWorkspaceDir()).toBe(resolve("/tmp/scope-a"))
    expect(b.getWorkspaceDir()).toBe(resolve("/tmp/scope-b"))
    expect(a.getWorkspaceDir()).not.toBe(b.getWorkspaceDir())
  })

  test("Room.getWorkspaceDir defaults to config.workspaceDir when unspecified", () => {
    const room = new Room({} as any, hub, {} as any, [])
    expect(room.getWorkspaceDir()).toBe(config.workspaceDir)
  })

  test("emit() tags broadcasts with roomId", () => {
    const broadcasts: Array<{ event: string; data: unknown }> = []
    const patchedHub = new SseHub(1)
    patchedHub.broadcast = (event, data) => {
      broadcasts.push({ event, data })
    }

    const room = new Room(
      { roster: () => [], onChange: null, personaStates: () => [] } as any,
      patchedHub,
      { write: async () => {}, load: async () => null, list: async () => [] } as any,
      [],
      "tagged-room",
    )

    // setChaining() broadcasts a "settings" event through emit() — use it to verify roomId tagging
    room.setChaining(true)

    expect(broadcasts.length).toBeGreaterThan(0)
    const settingsBroadcast = broadcasts.find((b) => b.event === "settings")
    expect(settingsBroadcast).toBeDefined()
    expect((settingsBroadcast!.data as Record<string, unknown>).roomId).toBe("tagged-room")
  })

  test("emit() passes roomId as the broadcast filter param (not just the payload tag)", () => {
    const calls: Array<{ event: string; roomId?: string }> = []
    const patchedHub = new SseHub(1)
    patchedHub.broadcast = (event, _data, roomId) => {
      calls.push({ event, roomId })
    }

    const room = new Room(
      { roster: () => [], onChange: null, personaStates: () => [] } as any,
      patchedHub,
      { write: async () => {}, load: async () => null, list: async () => [] } as any,
      [],
      "param-room",
    )

    room.setChaining(true)

    const settings = calls.find((c) => c.event === "settings")
    expect(settings).toBeDefined()
    expect(settings!.roomId).toBe("param-room")
  })

  // ── Manifest persistence (PLAN-399e8072) ───────────────────────────────────

  describe("manifest persistence", () => {
    let tmpDir: string
    let prevSessionsDir: string

    beforeEach(() => {
      tmpDir = mkdtempSync(resolve(tmpdir(), "room-manifest-"))
      prevSessionsDir = config.sessionsDir
      // Point the manifest at an isolated temp dir for the duration of the test.
      ;(config as { sessionsDir: string }).sessionsDir = tmpDir
    })

    afterEach(() => {
      ;(config as { sessionsDir: string }).sessionsDir = prevSessionsDir
      rmSync(tmpDir, { recursive: true, force: true })
    })

    const manifestFile = () => resolve(tmpDir, "rooms.json")

    test("saveManifest writes valid JSON to sessions/rooms.json", async () => {
      manager.createDefaultRoom()
      await manager.saveManifest()
      expect(existsSync(manifestFile())).toBe(true)
      const parsed = JSON.parse(readFileSync(manifestFile(), "utf8"))
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed).toContainEqual({ roomId: "default", name: "main-room" })
    })

    test("loadManifest round-trips what saveManifest wrote", async () => {
      manager.createDefaultRoom()
      manager.createRoom("room-2", "Second", undefined, "/tmp/scope-x")
      await manager.saveManifest()

      const entries = await manager.loadManifest()
      const byId = Object.fromEntries(entries.map((e) => [e.roomId, e]))
      expect(byId["default"]).toEqual({ roomId: "default", name: "main-room" })
      expect(byId["room-2"]).toEqual({
        roomId: "room-2",
        name: "Second",
        workspaceDir: resolve("/tmp/scope-x"),
      })
    })

    test("default-scoped rooms store neither workspaceDir nor sshTarget", async () => {
      manager.createRoom("plain", "Plain")
      await manager.saveManifest()
      const [entry] = (await manager.loadManifest()).filter((e) => e.roomId === "plain")
      expect(entry).toEqual({ roomId: "plain", name: "Plain" })
    })

    test("createRoom triggers a manifest write", async () => {
      manager.createRoom("auto-save", "Auto")
      // saveManifest() chains onto the same saveQueue as createRoom's fire-and-
      // forget write, so awaiting it guarantees that earlier write has drained.
      await manager.saveManifest()
      expect((await manager.loadManifest()).some((e) => e.roomId === "auto-save")).toBe(true)
    })

    test("destroyRoom triggers a manifest write", async () => {
      manager.createRoom("keep", "Keep")
      manager.createRoom("drop", "Drop")
      await manager.destroyRoom("drop")
      await manager.saveManifest()
      const ids = (await manager.loadManifest()).map((e) => e.roomId)
      expect(ids).toContain("keep")
      expect(ids).not.toContain("drop")
    })

    test("renameRoom triggers a manifest write", async () => {
      manager.createRoom("renamable", "Old Name")
      manager.renameRoom("renamable", "New Name")
      await manager.saveManifest()
      const [entry] = (await manager.loadManifest()).filter((e) => e.roomId === "renamable")
      expect(entry.name).toBe("New Name")
    })

    test("restoreRooms re-creates non-default rooms from the manifest", async () => {
      writeFileSync(
        manifestFile(),
        JSON.stringify([
          { roomId: "default", name: "main-room" },
          { roomId: "restored", name: "Restored Room" },
        ]),
      )
      manager.createDefaultRoom()
      await manager.restoreRooms()
      expect(manager.getRoom("restored")).toBeDefined()
      expect(manager.getRoomDetails("restored")!.name).toBe("Restored Room")
    })

    test("restoreRooms restores a renamed default room name", async () => {
      writeFileSync(
        manifestFile(),
        JSON.stringify([{ roomId: "default", name: "Custom Default" }]),
      )
      manager.createDefaultRoom() // created as "main-room"
      await manager.restoreRooms()
      expect(manager.getRoomDetails("default")!.name).toBe("Custom Default")
    })

    test("restoreRooms restores a custom local workspaceDir", async () => {
      writeFileSync(
        manifestFile(),
        JSON.stringify([
          { roomId: "scoped", name: "Scoped", workspaceDir: "/tmp/restore-scope" },
        ]),
      )
      manager.createDefaultRoom()
      await manager.restoreRooms()
      expect(manager.getRoomDetails("scoped")!.workspaceDir).toBe(resolve("/tmp/restore-scope"))
    })

    test("a degraded sshfs room (mount failed) still persists its sshTarget", async () => {
      // Simulates restoreRooms' degraded path: no live mount, but the intended
      // sshTarget is recorded so it survives the next save. Without this the
      // target is permanently lost after one restart with the remote down.
      manager.createRoom("vps", "VPS", undefined, undefined, undefined, "dax@10.0.0.1:/home/dax")
      await manager.saveManifest()
      const [entry] = (await manager.loadManifest()).filter((e) => e.roomId === "vps")
      expect(entry).toEqual({ roomId: "vps", name: "VPS", sshTarget: "dax@10.0.0.1:/home/dax" })
    })

    test("a degraded sshTarget survives an unrelated later mutation", async () => {
      // The real regression: a save triggered by *another* room must not drop
      // the degraded room's sshTarget when it rewrites the whole manifest.
      manager.createRoom("vps", "VPS", undefined, undefined, undefined, "dax@10.0.0.1:/srv")
      manager.createRoom("other", "Other") // triggers a full-manifest rewrite
      await manager.saveManifest()
      const [entry] = (await manager.loadManifest()).filter((e) => e.roomId === "vps")
      expect(entry.sshTarget).toBe("dax@10.0.0.1:/srv")
    })

    test("a live sshfs room persists its sshTarget, not the ephemeral mountpoint", async () => {
      manager.createRoom("vps2", "VPS2", undefined, "/tmp/mnt-x", {
        mountpoint: "/tmp/mnt-x",
        sshTarget: "dax@host:/path",
      })
      await manager.saveManifest()
      const [entry] = (await manager.loadManifest()).filter((e) => e.roomId === "vps2")
      expect(entry).toEqual({ roomId: "vps2", name: "VPS2", sshTarget: "dax@host:/path" })
      expect(entry.workspaceDir).toBeUndefined()
    })

    test("restoreRooms skips a room id that already exists", async () => {
      writeFileSync(
        manifestFile(),
        JSON.stringify([{ roomId: "dup", name: "From Manifest" }]),
      )
      manager.createDefaultRoom()
      manager.createRoom("dup", "Already Here")
      await manager.restoreRooms()
      // The live room is not clobbered by the manifest entry.
      expect(manager.getRoomDetails("dup")!.name).toBe("Already Here")
    })

    test("loadManifest returns [] for a corrupt manifest", async () => {
      writeFileSync(manifestFile(), "{ this is not valid json")
      expect(await manager.loadManifest()).toEqual([])
    })

    test("loadManifest returns [] when the manifest is absent", async () => {
      expect(await manager.loadManifest()).toEqual([])
    })

    test("loadManifest drops malformed entries (missing roomId/name)", async () => {
      writeFileSync(
        manifestFile(),
        JSON.stringify([
          { roomId: "good", name: "Good" },
          { roomId: "no-name" },
          { name: "no-id" },
          "garbage",
          null,
        ]),
      )
      const entries = await manager.loadManifest()
      expect(entries).toEqual([{ roomId: "good", name: "Good" }])
    })

    test("restoreRooms on an absent manifest leaves only the default room", async () => {
      manager.createDefaultRoom()
      await manager.restoreRooms()
      expect(manager.listRooms().map((r) => r.roomId)).toEqual(["default"])
    })
  })

  test("two rooms sharing one hub deliver isolated events to room-filtered clients", () => {
    // End-to-end: emit() in room-a must reach only the room-a SSE client, never
    // room-b's. This is the cross-room leak the explicit roomId param closes.
    const sharedHub = new SseHub()
    const writesA: string[] = []
    const writesB: string[] = []
    const mk = (sink: string[]) =>
      ({
        setHeader: () => {},
        flushHeaders: () => {},
        write: (d: string) => { if (typeof d === "string" && d.includes("event:")) sink.push(d) },
        on: () => {},
      } as any)
    sharedHub.addClient(mk(writesA), "room-a")
    sharedHub.addClient(mk(writesB), "room-b")

    const store = { write: async () => {}, load: async () => null, list: async () => [] } as any
    const reg = { roster: () => [], onChange: null, personaStates: () => [] } as any
    const roomA = new Room(reg, sharedHub, store, [], "room-a")
    const roomB = new Room(reg, sharedHub, store, [], "room-b")

    roomA.setChaining(true)
    roomB.setChaining(false)

    expect(writesA.some((w) => w.includes("event: settings"))).toBe(true)
    expect(writesB.some((w) => w.includes("event: settings"))).toBe(true)
    // No leak: room-a's client must not have received room-b's broadcast and vice versa.
    expect(writesA).toHaveLength(1)
    expect(writesB).toHaveLength(1)
  })
})
