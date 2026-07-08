import { describe, expect, test, vi } from "vitest"
import { buildCustomTools, availableCustomTools, ORCHESTRATION_TOOLS } from "../custom-tools/index.js"
import { createSpawnRoomToolDefinition } from "../custom-tools/spawn-room.js"
import { createCheckRoomToolDefinition } from "../custom-tools/check-room.js"
import { createStopRoomToolDefinition } from "../custom-tools/stop-room.js"
import { createDestroyRoomToolDefinition } from "../custom-tools/destroy-room.js"
import type { RoomOrchestrator } from "../orchestrator.js"

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as { text: string }).text
}

function mockOrchestrator(overrides: Partial<RoomOrchestrator> = {}): RoomOrchestrator {
  return {
    spawnRoom: vi.fn(async (o) => ({ roomId: "room-abc", name: o.name, goalStatus: "running" })),
    checkRoom: vi.fn((roomId) => ({
      found: true,
      roomId,
      name: "sub",
      goalStatus: "completed",
      goalText: "do the thing",
      lastMessages: ["Builder: done", "Auditor: looks good"],
    })),
    stopRoom: vi.fn(async () => true),
    destroyRoom: vi.fn(async () => true),
    answerRoom: vi.fn(() => true),
    ...overrides,
  }
}

/* ── buildCustomTools gating ──────────────────────── */

describe("buildCustomTools — orchestration gating", () => {
  test("does NOT build orchestration tools without an orchestrator", () => {
    const tools = buildCustomTools(["spawn_room", "check_room", "destroy_room"])
    expect(tools).toHaveLength(0)
  })

  test("builds orchestration tools when orchestrator is supplied", () => {
    const tools = buildCustomTools(
      ["spawn_room", "check_room", "destroy_room"],
      { orchestrator: mockOrchestrator() },
    )
    expect(tools.map((t) => t.name).sort()).toEqual(["check_room", "destroy_room", "spawn_room"])
  })

  test("only builds the orchestration tools in the allowlist", () => {
    const tools = buildCustomTools(["spawn_room"], { orchestrator: mockOrchestrator() })
    expect(tools.map((t) => t.name)).toEqual(["spawn_room"])
  })

  test("builds stop_room when requested", () => {
    const tools = buildCustomTools(["stop_room"], { orchestrator: mockOrchestrator() })
    expect(tools.map((t) => t.name)).toEqual(["stop_room"])
  })

  test("stop_room is a context-gated orchestration tool", () => {
    expect(ORCHESTRATION_TOOLS).toContain("stop_room")
    // Not built without an orchestrator (same contract as the others).
    expect(buildCustomTools(["stop_room"])).toHaveLength(0)
  })

  test("mixes research and orchestration tools", () => {
    const tools = buildCustomTools(
      ["web_search", "spawn_room"],
      { orchestrator: mockOrchestrator() },
    )
    expect(tools.map((t) => t.name).sort()).toEqual(["spawn_room", "web_search"])
  })

  test("orchestration tools are not part of the static availableCustomTools registry", () => {
    // They are context-gated, so they stay out of the always-available list.
    const names = availableCustomTools()
    for (const t of ORCHESTRATION_TOOLS) {
      expect(names).not.toContain(t)
    }
  })
})

/* ── spawn_room ───────────────────────────────────── */

describe("spawn_room tool", () => {
  test("calls orchestrator.spawnRoom and reports the roomId", async () => {
    const orch = mockOrchestrator()
    const tool = createSpawnRoomToolDefinition(orch)
    const result = await tool.execute(
      "tc1",
      { name: "audit-x", goal: "audit the auth flow", preset: "local-default" },
      undefined, undefined, {} as any,
    )
    expect(orch.spawnRoom).toHaveBeenCalledWith({
      name: "audit-x",
      goal: "audit the auth flow",
      preset: "local-default",
      workspaceDir: undefined,
    })
    const text = textOf(result)
    expect(text).toContain("room-abc")
    expect(text).toContain("audit-x")
    expect(text).toContain("check_room")
  })

  test("returns a readable error when spawnRoom throws", async () => {
    const orch = mockOrchestrator({
      spawnRoom: vi.fn(async () => { throw new Error('preset "nope" not found') }),
    })
    const tool = createSpawnRoomToolDefinition(orch)
    const result = await tool.execute(
      "tc1", { name: "x", goal: "y", preset: "nope" }, undefined, undefined, {} as any,
    )
    expect(textOf(result)).toContain("spawn_room error")
    expect(textOf(result)).toContain('preset "nope" not found')
  })
})

/* ── check_room ───────────────────────────────────── */

describe("check_room tool", () => {
  test("reports status, goal, and last messages", async () => {
    const orch = mockOrchestrator()
    const tool = createCheckRoomToolDefinition(orch)
    const result = await tool.execute("tc1", { roomId: "room-abc" }, undefined, undefined, {} as any)
    const text = textOf(result)
    expect(text).toContain("completed")
    expect(text).toContain("do the thing")
    expect(text).toContain("Builder: done")
    expect(text).toContain("Auditor: looks good")
  })

  test("handles a missing room", async () => {
    const orch = mockOrchestrator({ checkRoom: vi.fn((roomId) => ({ found: false, roomId })) })
    const tool = createCheckRoomToolDefinition(orch)
    const result = await tool.execute("tc1", { roomId: "ghost" }, undefined, undefined, {} as any)
    expect(textOf(result)).toContain("no room with id \"ghost\"")
  })

  test("handles a running room with no transcript yet", async () => {
    const orch = mockOrchestrator({
      checkRoom: vi.fn((roomId) => ({
        found: true, roomId, name: "sub", goalStatus: "running", goalText: "work", lastMessages: [],
      })),
    })
    const tool = createCheckRoomToolDefinition(orch)
    const result = await tool.execute("tc1", { roomId: "room-abc" }, undefined, undefined, {} as any)
    expect(textOf(result)).toContain("running")
    expect(textOf(result)).toContain("no transcript yet")
  })
})

/* ── destroy_room ─────────────────────────────────── */

describe("destroy_room tool", () => {
  test("confirms destruction", async () => {
    const orch = mockOrchestrator()
    const tool = createDestroyRoomToolDefinition(orch)
    const result = await tool.execute("tc1", { roomId: "room-abc" }, undefined, undefined, {} as any)
    expect(orch.destroyRoom).toHaveBeenCalledWith("room-abc")
    expect(textOf(result)).toContain("Destroyed room")
  })

  test("reports when the room cannot be destroyed", async () => {
    const orch = mockOrchestrator({ destroyRoom: vi.fn(async () => false) })
    const tool = createDestroyRoomToolDefinition(orch)
    const result = await tool.execute("tc1", { roomId: "default" }, undefined, undefined, {} as any)
    expect(textOf(result)).toContain("no room with id \"default\"")
  })

  test("returns a readable error when destroyRoom throws", async () => {
    const orch = mockOrchestrator({
      destroyRoom: vi.fn(async () => { throw new Error("unmount failed") }),
    })
    const tool = createDestroyRoomToolDefinition(orch)
    const result = await tool.execute("tc1", { roomId: "room-abc" }, undefined, undefined, {} as any)
    expect(textOf(result)).toContain("destroy_room error")
    expect(textOf(result)).toContain("unmount failed")
  })
})

/* ── stop_room ────────────────────────────── */

describe("stop_room tool", () => {
  test("calls orchestrator.stopRoom and confirms the halt", async () => {
    const orch = mockOrchestrator()
    const tool = createStopRoomToolDefinition(orch)
    const result = await tool.execute("tc1", { roomId: "room-abc" }, undefined, undefined, {} as any)
    expect(orch.stopRoom).toHaveBeenCalledWith("room-abc")
    const text = textOf(result)
    expect(text).toContain("Stopped room")
    expect(text).toContain("check_room")
  })

  test("reports when the room cannot be stopped (protected / absent)", async () => {
    const orch = mockOrchestrator({ stopRoom: vi.fn(async () => false) })
    const tool = createStopRoomToolDefinition(orch)
    const result = await tool.execute("tc1", { roomId: "default" }, undefined, undefined, {} as any)
    expect(textOf(result)).toContain("no room with id \"default\"")
  })

  test("returns a readable error when stopRoom throws", async () => {
    const orch = mockOrchestrator({
      stopRoom: vi.fn(async () => { throw new Error("abort boom") }),
    })
    const tool = createStopRoomToolDefinition(orch)
    const result = await tool.execute("tc1", { roomId: "room-abc" }, undefined, undefined, {} as any)
    expect(textOf(result)).toContain("stop_room error")
    expect(textOf(result)).toContain("abort boom")
  })
})
