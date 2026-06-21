// SSHFS room scope — mount a remote directory (user@host:/path) as a local
// FUSE mountpoint so a room can be scoped to a directory on another machine.
//
// The mount is transparent to everything downstream: the sandbox, work-receipt
// snapshots, and the workspace listing all see a plain local directory. Only
// the mount/unmount lifecycle lives here.
//
// Caveat: bash still runs LOCALLY with the mountpoint as cwd. File I/O (read,
// write, edit, grep, find) traverses FUSE to the remote host, but processes
// (node, python, git) execute on this machine. This is "Option A" — remote
// files, local execution. Remote execution would be a different architecture.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, rmdir } from "node:fs/promises"
import { join } from "node:path"

const execFileAsync = promisify(execFile)

/** Base directory under which per-room mountpoints are created. */
export const MOUNT_BASE = "/tmp/pipeline-moe-mounts"

/** Mount metadata recorded for an sshfs-scoped room. */
export interface RoomMount {
  /** Local FUSE mountpoint used as the room's workspaceDir. */
  mountpoint: string
  /** The original user@host:/path target, for display/diagnostics. */
  sshTarget: string
}

/** Matches an sshfs target: user@host:/path (path may be absolute or relative). */
const SSH_TARGET_RE = /^[^@\s]+@[^:\s]+:.+$/

/** True when the string looks like an sshfs target (user@host:/path), not a
 *  local path. A local path (absolute or relative) has no `user@host:` prefix. */
export function isSshTarget(s: string): boolean {
  return SSH_TARGET_RE.test(s.trim())
}

/** The deterministic local mountpoint for a room. roomId is already sanitised
 *  upstream ([a-zA-Z0-9_-] only), so this cannot escape MOUNT_BASE. */
export function mountpointFor(roomId: string): string {
  return join(MOUNT_BASE, roomId)
}

/** Whether the sshfs binary is available on this machine. */
export async function sshfsAvailable(): Promise<boolean> {
  try {
    await execFileAsync("sshfs", ["--version"])
    return true
  } catch {
    return false
  }
}

/**
 * Mount an sshfs target at the room's deterministic mountpoint and return the
 * local mountpoint path (to be used as the room's workspaceDir).
 *
 * Throws with a clear message when:
 *  - the target is not a valid user@host:/path string
 *  - sshfs is not installed
 *  - the mount command fails (key auth, unreachable host, bad remote path)
 *
 * On mount failure the empty mountpoint dir is removed so we don't leak it.
 */
export async function mountSshfs(roomId: string, sshTarget: string): Promise<string> {
  const target = sshTarget.trim()
  if (!isSshTarget(target)) {
    throw new Error(`"${target}" is not a valid SSH target (expected user@host:/path)`)
  }
  if (!(await sshfsAvailable())) {
    throw new Error("sshfs is not installed — run `sudo pacman -S sshfs`")
  }

  const mountpoint = mountpointFor(roomId)
  await mkdir(mountpoint, { recursive: true })

  try {
    await execFileAsync("sshfs", [
      target,
      mountpoint,
      // BatchMode: fail immediately on auth prompt (no hanging on password).
      // reconnect + keepalive: survive WireGuard blips without dropping the mount.
      "-o",
      "BatchMode=yes,reconnect,ServerAliveInterval=15,ServerAliveCountMax=3",
    ])
  } catch (err) {
    // Roll back the empty mountpoint dir so a failed mount leaves no trace.
    await rmdir(mountpoint).catch(() => {})
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`sshfs mount failed for "${target}": ${msg}`)
  }

  return mountpoint
}

/**
 * Unmount an sshfs mountpoint and remove the (now empty) mountpoint dir.
 * Idempotent and best-effort: a mountpoint that is already unmounted or never
 * existed does not throw — teardown must always succeed.
 */
export async function unmountSshfs(mountpoint: string): Promise<void> {
  try {
    await execFileAsync("fusermount3", ["-u", mountpoint])
  } catch {
    // Fall back to fusermount (non-suffixed) on systems without fusermount3.
    try {
      await execFileAsync("fusermount", ["-u", mountpoint])
    } catch {
      // Already unmounted, never mounted, or binary missing — nothing to do.
    }
  }
  // Remove the empty mountpoint dir. Fails harmlessly if still busy or gone.
  await rmdir(mountpoint).catch(() => {})
}
