// Work receipts: snapshot the workspace before/after an agent turn and diff.
// A "signature" is size + mtimeMs, which is cheap and changes on any write.

import { readdir, stat } from "node:fs/promises"
import { join, relative } from "node:path"
import type { ToolActivity, WorkReceipt } from "./types.js"

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

/** File-mutating built-in tools whose args carry a target path. */
const FILE_WRITE_TOOLS = new Set(["write", "edit"])

/** Pull the target file path out of a tool call's args, tolerating the key pi
 *  uses (file_path / path / filePath). */
function toolPath(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined
  const a = args as Record<string, unknown>
  for (const key of ["file_path", "path", "filePath"]) {
    const v = a[key]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return undefined
}

/**
 * Build a work receipt from an agent's file-tool activity instead of a
 * before/after filesystem walk. Used for remote (sshfs) rooms, where walking
 * the whole tree per turn is too slow. It reads the actually-executed write/edit
 * tool calls (status "ok"), so it still reflects what happened on disk — not the
 * agent's text claims. Limitation vs the snapshot diff: it can't see files
 * changed as a side effect of `bash` (e.g. a script that writes output), and it
 * reports every touched path as "modified" (created-vs-modified needs the prior
 * on-disk state, which we deliberately don't fetch over the network).
 */
export function receiptFromActivity(activity: ToolActivity[], participantId: string): WorkReceipt {
  const modified = new Set<string>()
  for (const a of activity) {
    if (a.status !== "ok" || !FILE_WRITE_TOOLS.has(a.toolName)) continue
    const p = toolPath(a.args)
    if (p) modified.add(p)
  }
  return {
    participantId,
    created: [],
    modified: [...modified].sort(),
    deleted: [],
  }
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
