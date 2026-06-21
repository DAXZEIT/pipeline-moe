// RoomManager — thin coordinator that holds multiple Room instances.
//
// In the current (single-room) mode, `createDefaultRoom()` creates one "default"
// Room and all routes talk to it. Future multi-room support adds createRoom() /
// destroyRoom() and routes keyed by roomId.

import { resolve } from "node:path"
import { Registry } from "./registry.js"
import { Room } from "./room.js"
import { SseHub } from "./sse.js"
import { ConversationStore } from "./store.js"
import { config } from "./config.js"
import { LocalModelLock } from "./local-model-lock.js"
import type { ResolvedModel } from "./model.js"
import type { Persona } from "./types.js"

export interface RoomSummary {
  roomId: string
  name: string
  participantCount: number
  goalStatus: string
  goalText: string | null
}

export interface RoomDetails extends RoomSummary {
  isBusy: boolean
  transcriptLength: number
}

export class RoomManager {
  private rooms = new Map<string, { room: Room; name: string }>()
  /** Process-global semaphore for serializing local-model inference across all rooms. */
  private readonly localLock = new LocalModelLock()

  constructor(
    private readonly resolved: ResolvedModel,
    private readonly hub: SseHub,
    private readonly explicitlyEnabledProviders: Set<string>,
    private readonly seedPersonas: Persona[],
  ) {}

  /**
   * Create the default room.  Called once at startup in server.ts.
   * Returns the Room so the caller can call room.init() and seed presets.
   */
  createDefaultRoom(): Room {
    return this.createRoom("default", "main-room")
  }

  /**
   * Create a named room.  Each room gets its own Registry and ConversationStore.
   * Shared: SseHub (events are tagged with roomId), ResolvedModel, seed personas.
   */
  /**
   * Create a named room.  Each room gets its own Registry and ConversationStore.
   * @param overridePersonas  When provided, replaces seedPersonas entirely (for preset-based rooms).
   *                          When absent, seedPersonas are used as-is.
   */
  createRoom(roomId: string, name: string, overridePersonas?: Persona[]): Room {
    if (this.rooms.has(roomId)) {
      throw new Error(`Room "${roomId}" already exists`)
    }

    const registry = new Registry(this.resolved, this.hub, this.explicitlyEnabledProviders)
    const store = new ConversationStore(resolve(config.sessionsDir, roomId))
    const personas = overridePersonas ?? this.seedPersonas
    const room = new Room(registry, this.hub, store, personas, roomId, this.localLock)

    this.rooms.set(roomId, { room, name })
    return room
  }

  /** Get a room by id. Returns undefined when not found. */
  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId)?.room
  }

  /** Destroy a room and remove it from the manager. */
  destroyRoom(roomId: string): boolean {
    return this.rooms.delete(roomId)
  }

  /** Rename a room in place. Returns false when the room is not found. */
  renameRoom(roomId: string, newName: string): boolean {
    const entry = this.rooms.get(roomId)
    if (!entry) return false
    entry.name = newName
    return true
  }

  /** Snapshot list of all rooms. */
  listRooms(): RoomSummary[] {
    return [...this.rooms.entries()].map(([id, { room, name }]) => ({
      roomId: id,
      name,
      participantCount: room.rosterLength(),
      goalStatus: room.getGoalStatus(),
      goalText: room.getGoalText(),
    }))
  }

  /** Full details for one room. Returns undefined when not found. */
  getRoomDetails(roomId: string): RoomDetails | undefined {
    const entry = this.rooms.get(roomId)
    if (!entry) return undefined
    const { room, name } = entry
    return {
      roomId,
      name,
      participantCount: room.rosterLength(),
      goalStatus: room.getGoalStatus(),
      goalText: room.getGoalText(),
      isBusy: room.isBusy(),
      transcriptLength: room.getTranscript().length,
    }
  }
}
