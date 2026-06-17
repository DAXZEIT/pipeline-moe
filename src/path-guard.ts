// Shared path confinement guard used by both ConversationStore and sandbox-tools.
// Prevents path traversal by verifying that the resolved target path lives
// inside the allowed root directory.

import { isAbsolute, relative, resolve } from "node:path"

/** Throw if `target` resolves outside `root`. */
export function assertInside(root: string, target: string): void {
  const rel = relative(root, resolve(target))
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${"/"}`) || rel.startsWith("..\\") || isAbsolute(rel))) {
    throw new Error(`Permission denied: "${target}" is outside the allowed directory.`)
  }
}
