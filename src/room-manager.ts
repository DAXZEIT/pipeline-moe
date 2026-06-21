// RoomManager — thin coordinator that holds multiple Room instances.
//
// In the current (single-room) mode, `createDefaultRoom()` creates one "default"
// Room and all routes talk to it. Future multi-room support adds createRoom() /
// destroyRoom() and routes keyed by roomId.

import { resolve } from "node:path"
import { readFile, writeFile, rename, mkdir } from "node:fs/promises"
import { Registry } from "./registry.js"
import { Room } from "./room.js"
import { SseHub } from "./sse.js"
import { ConversationStore } from "./store.js"
import { config } from "./config.js"
import { LocalModelLock } from "./local-model-lock.js"
import { mountSshfs, unmountSshfs } from "./sshfs.js"
import type { RoomMount } from "./sshfs.js"
import type { ResolvedModel } from "./model.js"
import type { RoomOrchestrator } from "./orchestrator.js"
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
  /** The directory this room's agents are scoped to. */
  workspaceDir: string
}

/** One room's durable record in the manifest. The mountpoint is deliberately
 *  NOT stored — it is ephemeral (/tmp). For sshfs rooms we store the original
 *  `sshTarget` and re-mount on restart; for custom local-path rooms we store
 *  `workspaceDir`; for default-scoped rooms neither is present. */
export interface RoomManifestEntry {
  roomId: string
  name: string
  workspaceDir?: string
  sshTarget?: string
}

export class RoomManager {
  private rooms = new Map<
    string,
    {
      room: Room
      name: string
      workspaceDir: string
      /** Live FUSE mount, present only while the room's sshfs target is mounted. */
      mount?: RoomMount
      /** The room's *intended* sshfs target. Survives independently of `mount`:
       *  a degraded restore (mount failed, VPS down) has no live mount but must
       *  still persist this so the target isn't lost on the next save. */
      sshTarget?: string
    }
  >()
  /** Process-global semaphore for serializing local-model inference across all rooms. */
  private readonly localLock = new LocalModelLock()
  /** Capability surface for sub-room spawning, injected by the server after
   *  construction (it closes over preset/mount logic that lives in server.ts).
   *  Passed to each room's Registry so orchestrator personas get the tools.
   *  Must be set before createRoom() is called for the tools to be available. */
  private orchestrator?: RoomOrchestrator
  /** Serializes manifest writes so concurrent room mutations never interleave
   *  two writeFile-to-tmp operations. Each write snapshots the current Map. */
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly resolved: ResolvedModel,
    private readonly hub: SseHub,
    private readonly explicitlyEnabledProviders: Set<string>,
    private readonly seedPersonas: Persona[],
  ) {}

  /** Inject the sub-room orchestrator. Call once at startup, before createRoom. */
  setOrchestrator(orchestrator: RoomOrchestrator): void {
    this.orchestrator = orchestrator
  }

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
  createRoom(
    roomId: string,
    name: string,
    overridePersonas?: Persona[],
    workspaceDir?: string,
    /** Mount metadata when the room is scoped to an sshfs target. The caller
     *  (POST handler) performs the mount and passes the local mountpoint as
     *  `workspaceDir`; this records it so destroyRoom() can unmount. */
    mount?: RoomMount,
    /** The intended sshfs target, used when there is no live `mount` (degraded
     *  restore). When `mount` is present its sshTarget takes precedence — they
     *  are the same value in the happy path. */
    sshTarget?: string,
  ): Room {
    if (this.rooms.has(roomId)) {
      throw new Error(`Room "${roomId}" already exists`)
    }

    // Resolve the room's scope to an absolute path. Empty/undefined = the
    // pipeline workspace (default, backward-compatible behavior). For sshfs
    // rooms the caller already passes the absolute local mountpoint.
    const scope = workspaceDir && workspaceDir.trim()
      ? resolve(workspaceDir.trim())
      : config.workspaceDir

    const registry = new Registry(this.resolved, this.hub, this.explicitlyEnabledProviders, scope, roomId, this.orchestrator)
    const store = new ConversationStore(resolve(config.sessionsDir, roomId))
    const personas = overridePersonas ?? this.seedPersonas
    const room = new Room(
      registry,
      this.hub,
      store,
      personas,
      roomId,
      this.localLock,
      config.circuitBreaker,
      scope,
    )

    this.rooms.set(roomId, {
      room,
      name,
      workspaceDir: scope,
      mount,
      sshTarget: mount?.sshTarget ?? sshTarget,
    })
    void this.saveManifest()
    return room
  }

  /** Get a room by id. Returns undefined when not found. */
  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId)?.room
  }

  /** Destroy a room and remove it from the manager. Unmounts the room's sshfs
   *  mount first when present — teardown is intrinsic to the room lifecycle, so
   *  it lives here rather than in the HTTP handler. */
  async destroyRoom(roomId: string): Promise<boolean> {
    const entry = this.rooms.get(roomId)
    if (!entry) return false
    if (entry.mount) {
      await unmountSshfs(entry.mount.mountpoint)
    }
    const removed = this.rooms.delete(roomId)
    if (removed) void this.saveManifest()
    return removed
  }

  /** Unmount every active sshfs mount. Called on process exit (SIGINT/SIGTERM)
   *  so a normal shutdown doesn't leave orphaned FUSE mounts behind. */
  async cleanupAllMounts(): Promise<void> {
    await Promise.all(
      [...this.rooms.values()]
        .filter((e) => e.mount)
        .map((e) => unmountSshfs(e.mount!.mountpoint)),
    )
  }

  /** Rename a room in place. Returns false when the room is not found. */
  renameRoom(roomId: string, newName: string): boolean {
    const entry = this.rooms.get(roomId)
    if (!entry) return false
    entry.name = newName
    void this.saveManifest()
    return true
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  /** Absolute path of the manifest file, colocated with per-room session dirs. */
  private manifestPath(): string {
    return resolve(config.sessionsDir, "rooms.json")
  }

  /** Snapshot the current room set into manifest entries. */
  private manifestEntries(): RoomManifestEntry[] {
    return [...this.rooms.entries()].map(([roomId, e]) => {
      const entry: RoomManifestEntry = { roomId, name: e.name }
      if (e.sshTarget) {
        // sshfs room: store the durable target, not the ephemeral mountpoint.
        // Read from the entry (not e.mount) so a degraded room — intended target
        // recorded but mount currently down — still persists its sshTarget.
        entry.sshTarget = e.sshTarget
      } else if (e.workspaceDir !== config.workspaceDir) {
        // Custom local-path scope: store the path. Default scope stores nothing.
        entry.workspaceDir = e.workspaceDir
      }
      return entry
    })
  }

  /** Persist the current room set. Serialized through saveQueue and best-effort:
   *  a write failure is logged, never thrown — durability must not break a room
   *  mutation. Atomic (write .tmp, rename) so a crash mid-write can't corrupt.
   *
   *  The target dir, path, and entries are all snapshotted *now* (at call time),
   *  not when the queued write runs. This makes each save a pure snapshot of the
   *  moment it was triggered — the write can't drift onto a different sessionsDir
   *  if config changes underneath the async queue (matters in tests; in prod
   *  sessionsDir is constant). */
  saveManifest(): Promise<void> {
    const dir = config.sessionsDir
    const path = resolve(dir, "rooms.json")
    const entries = this.manifestEntries()
    this.saveQueue = this.saveQueue
      .then(() => this.writeManifest(dir, path, entries))
      .catch((err) => {
        console.error(
          `[room-manifest] save failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
    return this.saveQueue
  }

  private async writeManifest(
    dir: string,
    path: string,
    entries: RoomManifestEntry[],
  ): Promise<void> {
    const tmp = `${path}.tmp`
    await mkdir(dir, { recursive: true })
    await writeFile(tmp, JSON.stringify(entries, null, 2), "utf8")
    await rename(tmp, path)
  }

  /** Read and validate the manifest. Returns [] on missing or corrupt file —
   *  a bad manifest must never block startup (fall back to default-only). */
  async loadManifest(): Promise<RoomManifestEntry[]> {
    try {
      const raw = await readFile(this.manifestPath(), "utf8")
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (e): e is RoomManifestEntry =>
          !!e &&
          typeof e === "object" &&
          typeof (e as RoomManifestEntry).roomId === "string" &&
          typeof (e as RoomManifestEntry).name === "string",
      )
    } catch {
      return []
    }
  }

  /** Re-create non-default rooms from the manifest at startup. The default room
   *  must already exist (createDefaultRoom) — for it we only restore a renamed
   *  name. sshfs rooms are re-mounted; a mount failure degrades the room to the
   *  pipeline workspace (logged) rather than losing it. Each restored room is
   *  init()'d so its saved conversation reloads. */
  async restoreRooms(): Promise<void> {
    const entries = await this.loadManifest()
    for (const entry of entries) {
      if (entry.roomId === "default") {
        const def = this.rooms.get("default")
        if (def && def.name !== entry.name) this.renameRoom("default", entry.name)
        continue
      }
      if (this.rooms.has(entry.roomId)) continue

      let workspaceDir: string | undefined = entry.workspaceDir
      let mount: RoomMount | undefined
      if (entry.sshTarget) {
        try {
          const mountpoint = await mountSshfs(entry.roomId, entry.sshTarget)
          workspaceDir = mountpoint
          mount = { mountpoint, sshTarget: entry.sshTarget }
        } catch (err) {
          console.warn(
            `[room-restore] sshfs mount failed for "${entry.roomId}" (${entry.sshTarget}): ` +
              `${err instanceof Error ? err.message : String(err)}. ` +
              `Restoring in degraded mode (pipeline workspace).`,
          )
          workspaceDir = undefined
          mount = undefined
        }
      }

      try {
        // Pass entry.sshTarget so a degraded room (mount === undefined) still
        // records its intended target and survives the next save/restart.
        const room = this.createRoom(
          entry.roomId,
          entry.name,
          undefined,
          workspaceDir,
          mount,
          entry.sshTarget,
        )
        await room.init()
        console.log(`[room-restore] restored "${entry.roomId}" (${entry.name})`)
      } catch (err) {
        console.error(
          `[room-restore] failed to restore "${entry.roomId}": ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
        if (mount) await unmountSshfs(mount.mountpoint).catch(() => {})
      }
    }
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
    const { room, name, workspaceDir } = entry
    return {
      roomId,
      name,
      participantCount: room.rosterLength(),
      goalStatus: room.getGoalStatus(),
      goalText: room.getGoalText(),
      isBusy: room.isBusy(),
      transcriptLength: room.getTranscript().length,
      workspaceDir,
    }
  }
}
