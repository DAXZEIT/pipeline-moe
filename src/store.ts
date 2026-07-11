// Conversation persistence: one JSON file per group discussion under
// config.sessionsDir. The store knows nothing about live sessions — it only
// reads/writes Conversation snapshots. The Room owns the live<->disk mapping.

import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { assertInside } from "./path-guard.js"
import { config } from "./config.js"
import type { Conversation, ConversationMeta } from "./types.js"

export function conversationMeta(conv: Conversation): ConversationMeta {
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: conv.transcript.length,
  }
}

export class ConversationStore {
  constructor(private readonly dir: string = config.sessionsDir) {}

  /** Serializes write() calls so two concurrent saves of the same conversation
   *  can't race. Bug found live (2026-07-11): a multi-field settings PATCH fires
   *  several `void saveCurrent()` at once, and supervised routing adds async save
   *  points (supervisor decision + drain resume); overlapping writes collided on
   *  a shared tmp path — the losing rename threw ENOENT, crashing the server as
   *  an unhandled rejection, and in the softer case dropped the snapshot (losing
   *  a just-posted supervisor trace). Chaining makes the last-invoked write win. */
  private writeChain: Promise<void> = Promise.resolve()
  /** Monotonic tmp suffix so even writes that somehow bypass the chain (e.g. two
   *  store instances on the same dir) never share a tmp path. */
  private writeSeq = 0

  /** The directory this store persists into — the Room anchors per-agent pi
   *  session directories next to the conversation files it writes here. */
  get baseDir(): string {
    return this.dir
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  private file(id: string): string {
    const path = join(this.dir, `${id}.json`)
    assertInside(this.dir, path)
    return path
  }

  /** All saved conversations as metadata, most-recently-updated first. */
  async list(): Promise<ConversationMeta[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return []
    }
    const metas: ConversationMeta[] = []
    for (const name of names) {
      // meta.json is per-room metadata (RoomManager), not a conversation snapshot.
      if (!name.endsWith(".json") || name === "meta.json") continue
      try {
        const conv = JSON.parse(await readFile(join(this.dir, name), "utf8")) as Conversation
        metas.push(conversationMeta(conv))
      } catch {
        // Skip unreadable / half-written files rather than crashing the list.
      }
    }
    metas.sort((a, b) => b.updatedAt - a.updatedAt)
    return metas
  }

  async read(id: string): Promise<Conversation | null> {
    try {
      return JSON.parse(await readFile(this.file(id), "utf8")) as Conversation
    } catch {
      return null
    }
  }

  /** Atomic write (tmp + rename) so the list never sees a partial file, and
   *  serialized so concurrent saves of the same conversation can't collide on
   *  the tmp path (see writeChain). Each write uses a unique tmp so a failed
   *  rename can never take out a sibling's tmp, and cleans up its own tmp on
   *  failure rather than leaking it. */
  async write(conv: Conversation): Promise<void> {
    const run = this.writeChain.then(async () => {
      const final = this.file(conv.id)
      const tmp = `${final}.${process.pid}.${++this.writeSeq}.tmp`
      await writeFile(tmp, JSON.stringify(conv, null, 2), "utf8")
      try {
        await rename(tmp, final)
      } catch (err) {
        try { await unlink(tmp) } catch { /* already gone */ }
        throw err
      }
    })
    // Keep the chain alive even if this write rejects — one failed save must
    // not wedge every later save behind a rejected promise.
    this.writeChain = run.catch(() => {})
    return run
  }

  /** Resolve once every write queued so far has settled. Shutdown awaits this
   *  so an in-flight snapshot isn't cut mid-rename (auditor debt, 2026-07-11:
   *  the last snapshot was losable at exit). Never rejects — write() already
   *  surfaces its own failures; flush only waits the chain out. */
  async flush(): Promise<void> {
    await this.writeChain
  }

  async remove(id: string): Promise<void> {
    try {
      await unlink(this.file(id))
    } catch {
      // Already gone — fine.
    }
  }
}
