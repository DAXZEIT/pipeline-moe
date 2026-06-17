// Conversation persistence: one JSON file per group discussion under
// config.sessionsDir. The store knows nothing about live sessions — it only
// reads/writes Conversation snapshots. The Room owns the live<->disk mapping.

import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { config } from "./config.js"
import type { Conversation, ConversationMeta } from "./types.js"


/** Throw if `target` resolves outside `root` — prevents path traversal via conversation ids. */
function assertInside(root: string, target: string): void {
  const rel = relative(root, resolve(target))
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${"/"}`) || rel.startsWith("..\\") || rel.startsWith("/"))) {
    throw new Error(`Permission denied: "${target}" is outside the allowed directory.`)
  }
}

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
      if (!name.endsWith(".json")) continue
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

  /** Atomic write (tmp + rename) so the list never sees a partial file. */
  async write(conv: Conversation): Promise<void> {
    const tmp = `${this.file(conv.id)}.tmp`
    await writeFile(tmp, JSON.stringify(conv, null, 2), "utf8")
    await rename(tmp, this.file(conv.id))
  }

  async remove(id: string): Promise<void> {
    try {
      await unlink(this.file(id))
    } catch {
      // Already gone — fine.
    }
  }
}
