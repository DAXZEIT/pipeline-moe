// task_create / task_update / task_list — the room's shared task board.
// Available to EVERY agent whenever a TaskBoard is in the tool context (same
// gating pattern as the orchestration tools): the board is a coordination
// primitive, not a privilege. The planner's overlay makes it the board owner
// (creates the decomposition); every other agent updates the tasks it owns.
//
// Descriptions are written to be self-sufficient: personas persisted before
// this feature never heard of the board in their system prompt, so the tool
// list is how they discover it.

import { Type } from "typebox"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { TaskBoard } from "../task-board.js"
import type { RoomTask } from "../types.js"

const STATUS_GLYPH: Record<RoomTask["status"], string> = {
  pending: "[ ]",
  in_progress: "[▶]",
  completed: "[✔]",
}

function formatBoard(tasks: RoomTask[]): string {
  if (tasks.length === 0) return "The task board is empty."
  const lines = tasks.map(
    (t) =>
      `#${t.id} ${STATUS_GLYPH[t.status]} ${t.subject}` +
      (t.owner ? ` — @${t.owner}` : "") +
      (t.status === "in_progress" ? " (in progress)" : ""),
  )
  const done = tasks.filter((t) => t.status === "completed").length
  return `Task board (${done}/${tasks.length} done):\n${lines.join("\n")}`
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined }
}

const createSchema = Type.Object({
  subject: Type.String({
    description: "Short imperative title for the task, e.g. \"Fix the roster truncation\".",
  }),
  owner: Type.Optional(
    Type.String({
      description: "Agent id responsible for this task (e.g. \"builder\"). Omit if unassigned.",
    }),
  ),
})

const updateSchema = Type.Object({
  id: Type.Number({ description: "The task id (from task_create or task_list)." }),
  status: Type.Optional(
    Type.String({
      description:
        "New status: \"pending\", \"in_progress\" (set it when you START working the task) " +
        "or \"completed\" (ONLY when the work is fully done and verified).",
    }),
  ),
  subject: Type.Optional(Type.String({ description: "New subject, if rewording." })),
  owner: Type.Optional(
    Type.String({ description: "Reassign to this agent id. Empty string unassigns." }),
  ),
  delete: Type.Optional(
    Type.Boolean({ description: "true to remove the task entirely (created in error / obsolete)." }),
  ),
})

const listSchema = Type.Object({})

export function createTaskCreateToolDefinition(
  board: TaskBoard,
  /** Creator attribution, resolved at execution time when a function — on a
   *  fused seat the session serves several hats and the creator is whichever
   *  hat wears the current turn. */
  personaId: string | (() => string),
): ToolDefinition<typeof createSchema, undefined> {
  const idOf = typeof personaId === "function" ? personaId : () => personaId
  return {
    name: "task_create",
    label: "Create Task",
    description:
      "Add a task to the room's shared task board — the live, user-visible decomposition of the " +
      "current work. Use it when breaking work into trackable steps (typically the planner does " +
      "this when dispatching). Each task can have an owner agent; owners mark their task " +
      "in_progress when they start and completed when done (task_update). The board is shown " +
      "live to the user in the TUI and web UI.",
    parameters: createSchema,
    execute: async (_toolCallId, params) => {
      try {
        const task = board.create(params.subject, idOf(), params.owner)
        return ok(
          `Created task #${task.id}: "${task.subject}"${task.owner ? ` — owner @${task.owner}` : ""} (pending).`,
        )
      } catch (err) {
        return ok(`task_create error: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}

export function createTaskUpdateToolDefinition(
  board: TaskBoard,
): ToolDefinition<typeof updateSchema, undefined> {
  return {
    name: "task_update",
    label: "Update Task",
    description:
      "Update a task on the room's shared task board. Mark YOUR task \"in_progress\" when you " +
      "start working on it and \"completed\" ONLY when the work is fully done and verified — " +
      "never for partial work. Can also reword the subject, reassign the owner, or delete an " +
      "obsolete task. The board is shown live to the user.",
    parameters: updateSchema,
    execute: async (_toolCallId, params) => {
      try {
        if (params.delete) {
          const removed = board.delete(params.id)
          return ok(removed ? `Deleted task #${params.id}.` : `No task with id ${params.id}.`)
        }
        const task = board.update(params.id, {
          status: params.status,
          subject: params.subject,
          owner: params.owner,
        })
        return ok(
          `Task #${task.id} updated: "${task.subject}" — ${task.status}` +
            (task.owner ? `, owner @${task.owner}` : "") +
            ".",
        )
      } catch (err) {
        return ok(`task_update error: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}

export function createTaskListToolDefinition(
  board: TaskBoard,
): ToolDefinition<typeof listSchema, undefined> {
  return {
    name: "task_list",
    label: "List Tasks",
    description:
      "Read the room's shared task board: every task with its id, status ([ ] pending, " +
      "[▶] in progress, [✔] completed) and owner. Check it before creating tasks (avoid " +
      "duplicates) and to find what is assigned to you.",
    parameters: listSchema,
    execute: async () => ok(formatBoard(board.list())),
  }
}
