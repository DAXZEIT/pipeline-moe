// Shared task board — the live decomposition of the room's current work,
// mutated by agents through the task_* custom tools and displayed by the
// TUI/web clients. One board per room; contents are per-conversation
// (persisted in the conversation JSON, swapped on discussion switch).
//
// Deliberately NOT the plan system: plans (.pi/plans) are the global
// engineering contract (goal, design, risks, retro) and drive plan-aware
// routing; the board is room-scoped, cheap, and shows who is doing what
// RIGHT NOW. The planner's overlay tells it when to use which.

import type { RoomTask, TaskStatus } from "./types.js"

const STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"])

export class TaskBoard {
  private tasks: RoomTask[] = []
  private nextId = 1

  /** Fired after every mutation (create/update/delete). The Room hooks this
   *  to broadcast the board over SSE and schedule a conversation save. */
  onChange: (() => void) | null = null

  list(): RoomTask[] {
    return this.tasks.map((t) => ({ ...t }))
  }

  get(id: number): RoomTask | undefined {
    const t = this.tasks.find((t) => t.id === id)
    return t ? { ...t } : undefined
  }

  create(subject: string, createdBy: string, owner?: string): RoomTask {
    const trimmed = subject.trim()
    if (!trimmed) throw new Error("task subject must not be empty")
    const task: RoomTask = {
      id: this.nextId++,
      subject: trimmed,
      status: "pending",
      ...(owner ? { owner } : {}),
      createdBy,
      ts: Date.now(),
    }
    this.tasks.push(task)
    this.onChange?.()
    return { ...task }
  }

  update(id: number, patch: { status?: string; subject?: string; owner?: string | null }): RoomTask {
    const task = this.tasks.find((t) => t.id === id)
    if (!task) throw new Error(`no task with id ${id}`)
    if (patch.status !== undefined) {
      if (!STATUSES.has(patch.status)) {
        throw new Error(`invalid status "${patch.status}" — use pending, in_progress or completed`)
      }
      task.status = patch.status as TaskStatus
    }
    if (patch.subject !== undefined) {
      const trimmed = patch.subject.trim()
      if (!trimmed) throw new Error("task subject must not be empty")
      task.subject = trimmed
    }
    if (patch.owner !== undefined) {
      if (patch.owner === null || patch.owner === "") delete task.owner
      else task.owner = patch.owner
    }
    this.onChange?.()
    return { ...task }
  }

  delete(id: number): boolean {
    const before = this.tasks.length
    this.tasks = this.tasks.filter((t) => t.id !== id)
    const removed = this.tasks.length < before
    if (removed) this.onChange?.()
    return removed
  }

  /** Replace the whole board (conversation switch / load). Does NOT fire
   *  onChange — the caller broadcasts as part of its own bootstrap. */
  load(tasks: RoomTask[]): void {
    this.tasks = tasks.map((t) => ({ ...t }))
    this.nextId = this.tasks.reduce((max, t) => Math.max(max, t.id), 0) + 1
  }

  serialize(): RoomTask[] {
    return this.list()
  }
}
