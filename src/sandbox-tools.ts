// Workspace-confined tools. pi's built-in file tools resolve relative paths
// against cwd but will happily honor an absolute path anywhere on disk (we saw
// an agent write to $HOME). For a multi-agent room we replace the built-ins
// with custom tools whose operations reject any path that escapes the workspace
// root, so file work — and therefore work receipts — stays inside the workspace.
//
// Note: `bash` cannot be hard-jailed without containerization; we pin its cwd to
// the workspace as a best effort. Treat bash as trusted-local only.

import { access as fsAccess, constants, mkdir, readFile, writeFile } from "node:fs/promises"
import { Type } from "typebox"
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
import type { AgentToolResult } from "@earendil-works/pi-coding-agent"

// Minimal text content type (mirrors pi-ai TextContent — not re-exported).
interface TextContent {
  type: "text"
  text: string
}
import { assertInside } from "./path-guard.js"

// ── ask_user tool ──────────────────────────────────────────────────────────
// Allows an agent to pause the pipeline and ask the user a clarifying question.
// The tool returns a confirmation message with terminate=true so the agent
// naturally stops its turn. The Room detects this tool call in the activity
// log and enters a "paused" state until the user responds.

const askUserSchema = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  options: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: 6,
      description:
        "2-6 short answer choices, when the answer space is known (yes/no, pick a file, " +
        "choose an approach). The user picks one or types a custom answer — offering " +
        "options makes answering faster and the reply unambiguous.",
    }),
  ),
})

export function createAskUserToolDefinition(): ToolDefinition<typeof askUserSchema, undefined> {
  return {
    name: "ask_user",
    label: "Ask User",
    description:
      "Pause the pipeline and ask the user a clarifying question. " +
      "Use this when you need information only the user can provide — " +
      "preferences, credentials, or context you cannot determine yourself. " +
      "When the possible answers are known, pass 2-6 short `options` the user can " +
      "pick from (they can always type a custom answer instead). " +
      "The pipeline will pause and wait for the user's response. " +
      "Do not use this for rhetorical questions or self-clarification.",
    parameters: askUserSchema,
    async execute(_toolCallId, { question }) {
      const content: TextContent[] = [{
        type: "text",
        text: `Question sent to user: "${question}". The pipeline is paused. Waiting for the user's response. When the user replies, their answer will be delivered to you as the next input.`,
      }]
      const result: AgentToolResult<undefined> = { content, details: undefined, terminate: true }
      return result
    },
  }
}

/** Build the confined tool definitions for the given built-in tool names. */
export function buildConfinedTools(
  root: string,
  toolNames: string[],
  /** Extra directories the READ tool may open (never write/edit/bash) — used
   *  to expose persona skill roots (SKILL.md + companion files) that live
   *  outside the workspace. */
  extraReadRoots: string[] = [],
): ToolDefinition[] {
  const wanted = new Set(toolNames)
  const tools: ToolDefinition[] = []

  // Readable = inside the workspace root, or inside one of the read-only
  // extra roots. Re-throws assertInside's permission error when nothing matches.
  const assertReadable = (p: string): void => {
    let lastErr: unknown
    for (const r of [root, ...extraReadRoots]) {
      try {
        assertInside(r, p)
        return
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr
  }

  if (wanted.has("read")) {
    tools.push(
      createReadToolDefinition(root, {
        operations: {
          readFile: async (p) => {
            assertReadable(p)
            return readFile(p)
          },
          access: async (p) => {
            assertReadable(p)
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

  // ask_user: available to all agents — no sandboxing needed, it's a communication tool.
  tools.push(createAskUserToolDefinition() as ToolDefinition)

  return tools
}
