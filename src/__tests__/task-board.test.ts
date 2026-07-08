import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
import { TaskBoard } from "../task-board.js"
import {
  createTaskCreateToolDefinition,
  createTaskListToolDefinition,
  createTaskUpdateToolDefinition,
} from "../custom-tools/task-tools.js"
import type { Conversation, ConversationMeta, Persona, PersonaState, RoomTask } from "../types.js"

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as { text: string }).text
}

// The shared task board: agents mutate it through the task_* tools, the Room
// broadcasts it over SSE and persists it in the conversation JSON. The board
// instance is SHARED between Registry (tools) and Room (persistence) — these
// tests exercise that exact contract with a real Room.

// ── TaskBoard unit ──────────────────────────────────────────────────────────

describe("TaskBoard", () => {
  test("create/update/delete lifecycle with onChange", () => {
    const board = new TaskBoard()
    let changes = 0
    board.onChange = () => changes++

    const t = board.create("Fix the roster", "planner", "builder")
    expect(t).toMatchObject({ id: 1, subject: "Fix the roster", status: "pending", owner: "builder", createdBy: "planner" })

    board.update(1, { status: "in_progress" })
    expect(board.get(1)!.status).toBe("in_progress")

    board.update(1, { status: "completed", owner: "" })
    expect(board.get(1)!.status).toBe("completed")
    expect(board.get(1)!.owner).toBeUndefined()

    expect(board.delete(1)).toBe(true)
    expect(board.delete(1)).toBe(false)
    expect(changes).toBe(4) // create + 2 updates + 1 real delete
  })

  test("rejects bad input", () => {
    const board = new TaskBoard()
    expect(() => board.create("   ", "planner")).toThrow(/empty/)
    expect(() => board.update(99, { status: "completed" })).toThrow(/no task/)
    board.create("ok", "planner")
    expect(() => board.update(1, { status: "done" })).toThrow(/invalid status/)
  })

  test("load replaces contents and continues ids after the max", () => {
    const board = new TaskBoard()
    board.load([
      { id: 3, subject: "a", status: "completed", createdBy: "planner", ts: 1 },
      { id: 7, subject: "b", status: "pending", createdBy: "planner", ts: 2 },
    ])
    expect(board.list()).toHaveLength(2)
    const next = board.create("c", "planner")
    expect(next.id).toBe(8)
  })
})

// ── task_* tools drive the board ────────────────────────────────────────────

describe("task_* tools", () => {
  test("create → update → list round-trip", async () => {
    const board = new TaskBoard()
    const create = createTaskCreateToolDefinition(board, "planner")
    const update = createTaskUpdateToolDefinition(board)
    const list = createTaskListToolDefinition(board)

    const created = await create.execute("t1", { subject: "Ship the feature", owner: "builder" } as never, undefined as never, undefined as never, {} as never)
    expect(textOf(created)).toContain("Created task #1")

    const progressed = await update.execute("t2", { id: 1, status: "in_progress" } as never, undefined as never, undefined as never, {} as never)
    expect(textOf(progressed)).toContain("in_progress")

    const listed = await list.execute("t3", {} as never, undefined as never, undefined as never, {} as never)
    expect(textOf(listed)).toContain("[▶] Ship the feature — @builder")

    const removed = await update.execute("t4", { id: 1, delete: true } as never, undefined as never, undefined as never, {} as never)
    expect(textOf(removed)).toContain("Deleted task #1")
    expect(board.list()).toHaveLength(0)
  })

  test("errors come back as tool text, never as throws", async () => {
    const board = new TaskBoard()
    const update = createTaskUpdateToolDefinition(board)
    const res = await update.execute("t1", { id: 42, status: "completed" } as never, undefined as never, undefined as never, {} as never)
    expect(textOf(res)).toContain("task_update error: no task with id 42")
  })
})

// ── Room integration: SSE broadcast + persistence ───────────────────────────

class MockRegistry {
  onChange: (() => void) | null = null
  activeParticipants() { return [] }
  personaStates(): PersonaState[] { return [] }
  get(_id: string) { return undefined }
  has(_id: string) { return false }
  roster() { return [] }
  broadcastRoster() {}
  async reset(_states: PersonaState[]) {}
  setActive() {}
  kick() {}
  disposeAll() {}
  setDefaultThinkingLevel() {}
  setAllowCloud() {}
  setCompactionReserveTokens() {}
}

class MockStore {
  written: Conversation[] = []
  async init() {}
  async list(): Promise<ConversationMeta[]> { return [] }
  async read(_id: string): Promise<Conversation | null> { return null }
  async write(conv: Conversation) { this.written.push(conv) }
  async remove(_id: string) {}
}

function makePersona(id: string): Persona {
  return { id, name: id, color: "#000", icon: "🤖", tools: [], systemPrompt: "" }
}

describe("Room + TaskBoard integration", () => {
  let hub: SseHub
  let store: MockStore
  let board: TaskBoard
  let room: Room
  let taskEvents: Array<{ tasks: RoomTask[] }>

  beforeEach(() => {
    hub = new SseHub(1)
    store = new MockStore()
    board = new TaskBoard()
    taskEvents = []
    const orig = hub.broadcast.bind(hub)
    hub.broadcast = (event, data) => {
      if (event === "tasks") taskEvents.push(data as { tasks: RoomTask[] })
      orig(event, data)
    }
    room = new Room(
      new MockRegistry() as any, hub, store as any, [],
      "test-room", undefined, undefined, false, board,
    )
  })

  afterEach(async () => {
    await room.abortCurrent()
  })

  test("a board mutation broadcasts the full board and persists it", async () => {
    board.create("Wire the panel", "planner", "builder")
    expect(taskEvents).toHaveLength(1)
    expect(taskEvents[0].tasks).toHaveLength(1)
    expect(taskEvents[0].tasks[0].subject).toBe("Wire the panel")

    // scheduleSave is debounced (400ms) — wait for the write, then check
    // the conversation carries the board.
    await new Promise((r) => setTimeout(r, 600))
    const last = store.written.at(-1)
    expect(last?.tasks).toHaveLength(1)
    expect(last?.tasks?.[0]).toMatchObject({ subject: "Wire the panel", owner: "builder", status: "pending" })
  })

  test("getTasks() exposes the live board (REST snapshot path)", () => {
    board.create("a", "planner")
    board.create("b", "planner", "tester")
    expect(room.getTasks()).toHaveLength(2)
    expect(room.getTasks()[1].owner).toBe("tester")
  })
})
