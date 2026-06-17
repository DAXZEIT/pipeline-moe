// Work receipts: snapshot the workspace before/after an agent turn and diff.
// A "signature" is size + mtimeMs, which is cheap and changes on any write.

import { readdir, stat } from "node:fs/promises"
import { join, relative } from "node:path"
import type { WorkReceipt } from "./types.js"

const IGNORED = new Set([".git", "node_modules", ".pi", "__pycache__", "sessions", "agent_memory", "mdstrip", "temp_convert", "fetches", "media"])


export type Snapshot = Map<string, string>

async function walk(dir: string, root: string, out: Snapshot): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(full, root, out)
    } else if (entry.isFile()) {
      try {
        const s = await stat(full)
        out.set(relative(root, full), `${s.size}:${s.mtimeMs}`)
      } catch {
        // file vanished between readdir and stat — ignore
      }
    }
  }
}

export async function snapshot(workspaceDir: string): Promise<Snapshot> {
  const out: Snapshot = new Map()
  await walk(workspaceDir, workspaceDir, out)
  return out
}

export function diffSnapshots(
  before: Snapshot,
  after: Snapshot,
  participantId: string,
): WorkReceipt {
  const created: string[] = []
  const modified: string[] = []
  const deleted: string[] = []

  for (const [path, sig] of after) {
    const prev = before.get(path)
    if (prev === undefined) created.push(path)
    else if (prev !== sig) modified.push(path)
  }
  for (const path of before.keys()) {
    if (!after.has(path)) deleted.push(path)
  }

  return {
    participantId,
    created: created.sort(),
    modified: modified.sort(),
    deleted: deleted.sort(),
  }
}

export function receiptHasChanges(r: WorkReceipt): boolean {
  return r.created.length > 0 || r.modified.length > 0 || r.deleted.length > 0
}

/** Flat listing of the workspace for the UI's live file panel. */
export async function listWorkspace(
  workspaceDir: string,
): Promise<Array<{ path: string; size: number }>> {
  const snap = await snapshot(workspaceDir)
  return [...snap.entries()]
    .map(([path, sig]) => ({ path, size: Number(sig.split(":")[0]) || 0 }))
    .sort((a, b) => a.path.localeCompare(b.path))
}
