import { beforeEach, describe, expect, test } from "vitest"
import { RoomManager } from "../room-manager.js"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
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

  beforeEach(() => {
    hub = new SseHub(1)
    manager = new RoomManager(makeResolvedModel(), hub, new Set(), [])
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

  test("destroyRoom removes the room", () => {
    manager.createDefaultRoom()
    expect(manager.getRoom("default")).toBeDefined()
    const removed = manager.destroyRoom("default")
    expect(removed).toBe(true)
    expect(manager.getRoom("default")).toBeUndefined()
  })

  test("destroyRoom returns false for nonexistent room", () => {
    expect(manager.destroyRoom("ghost")).toBe(false)
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

  test("destroying a room removes it from listing", () => {
    manager.createRoom("temp", "Temp Room")
    expect(manager.listRooms()).toHaveLength(1)
    manager.destroyRoom("temp")
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
})
