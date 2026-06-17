// Workspace-confined tools. pi's built-in file tools resolve relative paths
// against cwd but will happily honor an absolute path anywhere on disk (we saw
// an agent write to $HOME). For a multi-agent room we replace the built-ins
// with custom tools whose operations reject any path that escapes the workspace
// root, so file work — and therefore work receipts — stays inside the workspace.
//
// Note: `bash` cannot be hard-jailed without containerization; we pin its cwd to
// the workspace as a best effort. Treat bash as trusted-local only.

import { access as fsAccess, constants, mkdir, readFile, writeFile } from "node:fs/promises"
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { assertInside } from "./path-guard.js"

/** Build the confined tool definitions for the given built-in tool names. */
export function buildConfinedTools(root: string, toolNames: string[]): ToolDefinition[] {
  const wanted = new Set(toolNames)
  const tools: ToolDefinition[] = []

  if (wanted.has("read")) {
    tools.push(
      createReadToolDefinition(root, {
        operations: {
          readFile: async (p) => {
            assertInside(root, p)
            return readFile(p)
          },
          access: async (p) => {
            assertInside(root, p)
            await fsAccess(p, constants.R_OK)
          },
        },
      }) as ToolDefinition,
    )
  }

  if (wanted.has("write")) {
    tools.push(
      createWriteToolDefinition(root, {
        operations: {
          writeFile: async (p, content) => {
            assertInside(root, p)
            await writeFile(p, content)
          },
          mkdir: async (dir) => {
            assertInside(root, dir)
            await mkdir(dir, { recursive: true })
          },
        },
      }) as ToolDefinition,
    )
  }

  if (wanted.has("edit")) {
    tools.push(
      createEditToolDefinition(root, {
        operations: {
          readFile: async (p) => {
            assertInside(root, p)
            return readFile(p)
          },
          writeFile: async (p, content) => {
            assertInside(root, p)
            await writeFile(p, content)
          },
          access: async (p) => {
            assertInside(root, p)
            await fsAccess(p, constants.R_OK | constants.W_OK)
          },
        },
      }) as ToolDefinition,
    )
  }

  if (wanted.has("bash")) {
    tools.push(
      createBashToolDefinition(root, {
        // Best-effort: always run from the workspace root. Not a hard jail.
        spawnHook: (ctx) => ({ ...ctx, cwd: root }),
      }) as ToolDefinition,
    )
  }

  // Read-only discovery tools: rooted at the workspace cwd (default operations).
  if (wanted.has("grep")) tools.push(createGrepToolDefinition(root) as ToolDefinition)
  if (wanted.has("find")) tools.push(createFindToolDefinition(root) as ToolDefinition)
  if (wanted.has("ls")) tools.push(createLsToolDefinition(root) as ToolDefinition)

  return tools
}
