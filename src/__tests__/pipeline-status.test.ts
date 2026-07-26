import { describe, expect, test, vi } from "vitest"
import { buildCustomTools } from "../custom-tools/index.js"
import { createPipelineStatusToolDefinition, renderPipelineStatus } from "../custom-tools/pipeline-status.js"
import { LocalModelLock } from "../local-model-lock.js"
import type { PipelineStatus, RoomOrchestrator } from "../orchestrator.js"

function status(over: Partial<PipelineStatus> = {}): PipelineStatus {
  return {
    rooms: [],
    maxRooms: 8,
    local: { capacity: 1, inUse: 0, holders: [], waiting: 0 },
    models: [],
    presets: [],
    ...over,
  }
}

function mockOrchestrator(s: PipelineStatus): RoomOrchestrator {
  return {
    spawnRoom: vi.fn(async () => ({ roomId: "x", name: "x", goalStatus: "running" })),
    checkRoom: vi.fn(() => ({ found: false, roomId: "x" })),
    stopRoom: vi.fn(async () => true),
    destroyRoom: vi.fn(async () => true),
    answerRoom: vi.fn(() => true),
    pipelineStatus: vi.fn(async () => s),
  }
}

const room = (roomId: string, over: Partial<PipelineStatus["rooms"][number]> = {}) => ({
  roomId,
  name: roomId,
  participantCount: 1,
  goalStatus: "idle",
  goalText: null,
  ...over,
})

// ── rendering ────────────────────────────────────────────────────────────────

describe("renderPipelineStatus", () => {
  test("counts rooms against the cap the agent cannot otherwise see", () => {
    const out = renderPipelineStatus(status({ rooms: [room("default"), room("solo-a")], maxRooms: 8 }))
    expect(out).toContain("ROOMS (2/8)")
  })

  test("marks the caller's own room", () => {
    const out = renderPipelineStatus(status({ rooms: [room("default"), room("solo-a")] }), "solo-a")
    const line = out.split("\n").find((l) => l.includes("solo-a"))!
    expect(line).toContain("← you")
    expect(out.split("\n").find((l) => l.includes("default"))).not.toContain("← you")
  })

  test("an unknown current room marks nothing rather than guessing", () => {
    const out = renderPipelineStatus(status({ rooms: [room("default")] }), "room-gone")
    expect(out).not.toContain("← you")
  })

  test("a goal is shown with its text, an idle room without", () => {
    const out = renderPipelineStatus(status({
      rooms: [room("audit", { goalStatus: "running", goalText: "audit the auth flow", participantCount: 3 })],
    }))
    expect(out).toContain("roster 3")
    expect(out).toContain("goal: running — audit the auth flow")
  })

  test("workspaceDir is shown so a spawn can reuse or avoid it", () => {
    const out = renderPipelineStatus(status({ rooms: [room("sub", { workspaceDir: "/home/dax/pipeline-moe" })] }))
    expect(out).toContain("/home/dax/pipeline-moe")
  })

  test("long ids break alignment rather than losing characters", () => {
    // A truncated roomId is an id the agent cannot pass back to check_room.
    const long = "solo-" + "x".repeat(40)
    expect(renderPipelineStatus(status({ rooms: [room(long), room("a")] }))).toContain(long)
  })

  test("a free local slot reads as free", () => {
    const out = renderPipelineStatus(status({ local: { capacity: 2, inUse: 1, holders: ["audit"], waiting: 0 } }))
    expect(out).toContain("LOCAL SLOTS: 1/2 in use — held by audit")
    expect(out).not.toContain("QUEUE")
  })

  test("a saturated local slot says so explicitly — this is the routing decision", () => {
    const out = renderPipelineStatus(status({
      local: { capacity: 2, inUse: 2, holders: ["default", "audit"], waiting: 1 },
    }))
    expect(out).toContain("2/2 in use")
    expect(out).toContain("held by default, audit")
    expect(out).toContain("1 waiting")
    expect(out).toContain("will QUEUE")
  })

  test("models are split local vs cloud", () => {
    const out = renderPipelineStatus(status({
      models: [
        { ref: "local/GRM 2.6", name: "GRM 2.6", local: true },
        { ref: "anthropic/claude-opus-5", name: "Opus 5", local: false },
      ],
    }))
    expect(out).toMatch(/local\/GRM 2\.6\s+local/)
    expect(out).toContain("anthropic/ — 1 cloud models:")
    expect(out).toContain("anthropic/claude-opus-5")
  })

  test("the cloud catalogue is sampled per provider, not dumped", () => {
    // Live run with PIPELINE_ALLOW_CLOUD on: ~100 refs, several thousand tokens
    // of menu in a local seat's context to answer "is there a cloud model".
    const models = [
      { ref: "local/GRM 2.6", name: "GRM", local: true },
      ...Array.from({ length: 40 }, (_, i) => ({ ref: `anthropic/m${i}`, name: `m${i}`, local: false })),
      ...Array.from({ length: 60 }, (_, i) => ({ ref: `huggingface/Q/m${i}`, name: `m${i}`, local: false })),
    ]
    const out = renderPipelineStatus(status({ models }))
    expect(out).toContain("anthropic/ — 40 cloud models:")
    expect(out).toContain("huggingface/ — 60 cloud models:")
    expect(out).toContain("… +35 more")
    expect(out).toContain("… +55 more")
    // Every local model still shown in full — those are the ones that contend.
    expect(out).toContain("local/GRM 2.6")
    expect(out.split("\n").length).toBeLessThan(35)
  })

  test("local-only says so — there is nowhere to escape the slot", () => {
    const out = renderPipelineStatus(status({ models: [{ ref: "local/GRM 2.6", name: "GRM", local: true }] }))
    expect(out).toContain("no cloud model available")
  })

  test("a multi-line goal stays one row", () => {
    const out = renderPipelineStatus(status({
      rooms: [room("a", { goalStatus: "running", goalText: "line one\nline two\n\nline three" }), room("b")],
    }))
    expect(out).toContain("goal: running — line one line two line three")
    // b must still be on its own row, not swallowed by a's goal.
    expect(out.split("\n").filter((l) => l.startsWith("  b"))).toHaveLength(1)
  })

  test("an essay-length goal is truncated rather than wrapping the table", () => {
    const out = renderPipelineStatus(status({
      rooms: [room("a", { goalStatus: "running", goalText: "x".repeat(400) })],
    }))
    const line = out.split("\n").find((l) => l.includes("goal: running"))!
    expect(line).toContain("…")
    expect(line.length).toBeLessThan(140)
  })

  test("presets list their roster — the names spawn_room accepts", () => {
    const out = renderPipelineStatus(status({
      presets: [{ name: "pi-audited", agents: ["pi", "auditor", "tester"] }],
    }))
    expect(out).toContain("pi-audited")
    expect(out).toContain("3 agents")
    expect(out).toContain("pi, auditor, tester")
  })

  test("empty sections say what that means instead of rendering a blank", () => {
    const out = renderPipelineStatus(status())
    expect(out).toContain("(none)")
    expect(out).toContain("(none available)")
    expect(out).toContain("spawn_room without a preset uses the default roster")
  })
})

// ── the tool ─────────────────────────────────────────────────────────────────

describe("pipeline_status tool", () => {
  test("renders what the orchestrator reports, marking the caller's room", async () => {
    const orch = mockOrchestrator(status({ rooms: [room("solo-a")], maxRooms: 4 }))
    const tool = createPipelineStatusToolDefinition(orch, "solo-a")
    const res = await tool.execute("t1", {} as never, undefined as never, undefined as never, {} as never)
    const text = (res.content[0] as { text: string }).text
    expect(orch.pipelineStatus).toHaveBeenCalled()
    expect(text).toContain("ROOMS (1/4)")
    expect(text).toContain("← you")
  })

  test("takes no arguments — nothing to hallucinate", () => {
    const tool = createPipelineStatusToolDefinition(mockOrchestrator(status()))
    expect(Object.keys((tool.parameters as { properties?: object }).properties ?? {})).toEqual([])
  })
})

// ── gating ───────────────────────────────────────────────────────────────────

describe("pipeline_status gating", () => {
  test("no orchestrator → no tool, like every other orchestration tool", () => {
    expect(buildCustomTools(["pipeline_status"])).toHaveLength(0)
  })

  test("rides along with any command tool, so rosters persisted before it are not blind", () => {
    // The planner personas living in presets/*.json list the five command tools
    // and nothing else. Requiring an allowlist entry would leave every one of
    // them commanding without observing until its file was hand-edited.
    for (const cmd of ["spawn_room", "check_room", "stop_room", "destroy_room", "answer_room"]) {
      const names = buildCustomTools([cmd], { orchestrator: mockOrchestrator(status()) }).map((t) => t.name)
      expect(names).toContain("pipeline_status")
    }
  })

  test("can also be granted alone — a seat that observes but cannot command", () => {
    const names = buildCustomTools(["pipeline_status"], { orchestrator: mockOrchestrator(status()) }).map((t) => t.name)
    expect(names).toEqual(["pipeline_status"])
  })

  test("a seat with no orchestration tools at all does not get it", () => {
    const names = buildCustomTools(["web_search"], { orchestrator: mockOrchestrator(status()) }).map((t) => t.name)
    expect(names).toEqual(["web_search"])
  })
})

// ── the capacity the report depends on ───────────────────────────────────────

describe("LocalModelLock capacity + holder labels", () => {
  test("defaults to 1 — unchanged behaviour for every existing caller", async () => {
    const lock = new LocalModelLock()
    expect(lock.capacity).toBe(1)
    await lock.acquire("a")
    expect(lock.inUse).toBe(1)
    let second = false
    void lock.acquire("b").then(() => { second = true })
    await Promise.resolve()
    expect(second).toBe(false)
    expect(lock.waitCount).toBe(1)
  })

  test("capacity 2 admits two rooms and queues the third", async () => {
    const lock = new LocalModelLock(2)
    await lock.acquire("r1")
    await lock.acquire("r2")
    expect(lock.owners).toEqual(["r1", "r2"])
    expect(lock.inUse).toBe(2)

    let third = false
    const p = lock.acquire("r3").then(() => { third = true })
    await Promise.resolve()
    expect(third).toBe(false)
    expect(lock.waiters).toEqual(["r3"])

    lock.release("r1")
    await p
    expect(third).toBe(true)
    expect(lock.owners).toEqual(["r2", "r3"])
    expect(lock.waitCount).toBe(0)
  })

  test("releasing frees THAT holder's slot, not whichever came first", async () => {
    const lock = new LocalModelLock(3)
    await lock.acquire("r1")
    await lock.acquire("r2")
    await lock.acquire("r3")
    lock.release("r2")
    expect(lock.owners).toEqual(["r1", "r3"])
  })

  test("an unlabelled release still frees a slot — a lost label beats a leaked slot", async () => {
    const lock = new LocalModelLock(2)
    await lock.acquire("r1")
    lock.release()
    expect(lock.inUse).toBe(0)
  })

  test("release with nothing held stays a safe no-op", () => {
    const lock = new LocalModelLock(2)
    expect(() => lock.release("ghost")).not.toThrow()
    expect(lock.inUse).toBe(0)
    expect(lock.isHeld).toBe(false)
  })

  test("owners/waiters are snapshots, not live internals", async () => {
    const lock = new LocalModelLock(1)
    await lock.acquire("r1")
    const snap = lock.owners
    lock.release("r1")
    expect(snap).toEqual(["r1"])
    expect(lock.owners).toEqual([])
  })
})
