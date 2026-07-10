import { describe, expect, test } from "vitest"
import { checkHandoffGates, globToRegExp, touchedPaths } from "../handoff-gates.js"
import { createHandoffToolDefinition } from "../custom-tools/handoff.js"
import type { HandoffGate, HandoffSink, ToolActivity } from "../types.js"

// Handoff review gates — the pipeline's "src/ passes through the auditor"
// norm as a core invariant instead of prose. Observed live (session
// mre5zpel, 2026-07-10, round 1): builder edited src/server.ts and handed
// straight to tester; the auditor never ran until the human complained.
// Same session, turn 27: planner batched TWO handoff calls, both "ok" —
// the second silently overwrote the first. Both classes are closed here.

const WS = "/ws"

function act(toolName: string, path: string, status: "ok" | "error" | "running" = "ok"): ToolActivity {
  return { toolCallId: `t${Math.random()}`, toolName, args: { path }, status, ts: 0 }
}

/* ── globToRegExp ─────────────────────────────────────────────────────── */

describe("globToRegExp", () => {
  test("src/** matches nested paths under src, not siblings", () => {
    const re = globToRegExp("src/**")
    expect(re.test("src/room.ts")).toBe(true)
    expect(re.test("src/custom-tools/handoff.ts")).toBe(true)
    expect(re.test("packages/tui/src/App.tsx")).toBe(false)
    expect(re.test("srcx/evil.ts")).toBe(false)
  })

  test("* stays within one segment, ** spans segments", () => {
    expect(globToRegExp("src/*.ts").test("src/room.ts")).toBe(true)
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false)
    expect(globToRegExp("**/x.test.ts").test("a/b/x.test.ts")).toBe(true)
    expect(globToRegExp("**/x.test.ts").test("x.test.ts")).toBe(true) // zero dirs
  })

  test("regex specials in the pattern are literal", () => {
    expect(globToRegExp("a+b/c.ts").test("a+b/c.ts")).toBe(true)
    expect(globToRegExp("a.ts").test("axts")).toBe(false)
  })
})

/* ── touchedPaths ─────────────────────────────────────────────────────── */

describe("touchedPaths", () => {
  test("collects ok write/edit paths only — bash, reads and failures don't count", () => {
    const activity = [
      act("edit", "src/room.ts"),
      act("write", "docs/x.md"),
      act("read", "src/secret.ts"),
      act("bash", "src/ignored.ts"),
      act("edit", "src/failed.ts", "error"),
    ]
    expect(touchedPaths(activity, WS)).toEqual(["docs/x.md", "src/room.ts"])
  })

  test("absolute paths inside the workspace are relativized; outside stay verbatim", () => {
    const activity = [act("edit", "/ws/src/room.ts"), act("edit", "/etc/other.conf")]
    expect(touchedPaths(activity, WS)).toEqual(["/etc/other.conf", "src/room.ts"])
  })
})

/* ── checkHandoffGates ────────────────────────────────────────────────── */

const GATE: HandoffGate = { from: "builder", via: "auditor", when: ["src/**"] }
const ROSTER = ["planner", "builder", "auditor", "tester", "scribe"]

describe("checkHandoffGates", () => {
  test("the live incident: builder edits src/ and hands to tester → blocked, names the auditor", () => {
    const msg = checkHandoffGates([GATE], "builder", "tester", [act("edit", "src/server.ts")], WS, ROSTER)
    expect(msg).toContain("blocked")
    expect(msg).toContain("src/server.ts")
    expect(msg).toContain('handoff(to: "auditor")')
  })

  test("handing to the required reviewer satisfies the gate", () => {
    expect(checkHandoffGates([GATE], "builder", "auditor", [act("edit", "src/server.ts")], WS, ROSTER)).toBeNull()
  })

  test("not armed when the turn touched nothing matching (TUI-only turn)", () => {
    expect(checkHandoffGates([GATE], "builder", "tester", [act("edit", "packages/tui/src/App.tsx")], WS, ROSTER)).toBeNull()
  })

  test("gate without `when` arms on every handoff from that agent", () => {
    const always: HandoffGate = { from: "builder", via: "auditor" }
    expect(checkHandoffGates([always], "builder", "tester", [], WS, ROSTER)).toContain("blocked")
    expect(checkHandoffGates([always], "builder", "auditor", [], WS, ROSTER)).toBeNull()
  })

  test("only gates for the calling agent apply", () => {
    expect(checkHandoffGates([GATE], "tester", "scribe", [act("edit", "src/x.ts")], WS, ROSTER)).toBeNull()
  })

  test("an absent/inactive reviewer never deadlocks the room — gate skipped", () => {
    // The auditor 403'd live on 2026-07-10; a dead reviewer must not trap the builder.
    const roster = ROSTER.filter((id) => id !== "auditor")
    expect(checkHandoffGates([GATE], "builder", "tester", [act("edit", "src/x.ts")], WS, roster)).toBeNull()
  })

  test("two armed gates with different reviewers: either reviewer passes, anyone else is blocked", () => {
    const gates: HandoffGate[] = [
      { from: "builder", via: "auditor", when: ["src/**"] },
      { from: "builder", via: "tester", when: ["src/**"] },
    ]
    const activity = [act("edit", "src/x.ts")]
    expect(checkHandoffGates(gates, "builder", "auditor", activity, WS, ROSTER)).toBeNull()
    expect(checkHandoffGates(gates, "builder", "tester", activity, WS, ROSTER)).toBeNull()
    expect(checkHandoffGates(gates, "builder", "scribe", activity, WS, ROSTER)).toContain("blocked")
  })

  test("absolute workspace path in tool args still arms a relative glob", () => {
    const msg = checkHandoffGates([GATE], "builder", "tester", [act("edit", "/ws/src/room.ts")], WS, ROSTER)
    expect(msg).toContain("blocked")
  })
})

/* ── handoff tool: double call + gate enforcement ─────────────────────── */

function gatedSink(
  ids: string[],
  opts?: { gateMessage?: string | null },
): HandoffSink & { registrations: Array<{ from: string; to: string }> } {
  const registrations: Array<{ from: string; to: string }> = []
  return {
    registrations,
    activeIds: () => ids,
    register: (from, to) => { registrations.push({ from, to }) },
    peekHandoff: (from) => registrations.find((r) => r.from === from)?.to,
    checkGate: () => opts?.gateMessage ?? null,
  }
}

describe("handoff tool — one handoff per turn", () => {
  test("second call in the same turn errors and does NOT overwrite the first", async () => {
    const sink = gatedSink(["planner", "builder", "tester"])
    const tool = createHandoffToolDefinition(sink, "planner")
    await tool.execute("tc1", { to: "tester" }, undefined, undefined, {} as any)
    const second = await tool.execute("tc2", { to: "builder" }, undefined, undefined, {} as any)
    expect(sink.registrations).toEqual([{ from: "planner", to: "tester" }])
    const text = (second.content[0] as { text: string }).text
    expect(text).toContain("already handed off to @tester")
  })

  test("a sink without peekHandoff (older doubles) keeps the legacy overwrite path", async () => {
    const registrations: Array<{ from: string; to: string }> = []
    const sink: HandoffSink = {
      activeIds: () => ["planner", "builder", "tester"],
      register: (from, to) => { registrations.push({ from, to }) },
    }
    const tool = createHandoffToolDefinition(sink, "planner")
    await tool.execute("tc1", { to: "tester" }, undefined, undefined, {} as any)
    await tool.execute("tc2", { to: "builder" }, undefined, undefined, {} as any)
    expect(registrations).toHaveLength(2)
  })
})

describe("handoff tool — gate enforcement", () => {
  test("a blocked handoff returns the gate message, no registration, no terminate", async () => {
    const sink = gatedSink(["planner", "builder", "auditor"], { gateMessage: "handoff to \"planner\" blocked by a review gate" })
    const tool = createHandoffToolDefinition(sink, "builder")
    const result = await tool.execute("tc1", { to: "planner" }, undefined, undefined, {} as any)
    expect(sink.registrations).toEqual([])
    expect((result.content[0] as { text: string }).text).toContain("blocked by a review gate")
    // Correctable: the model must get to re-route in the same turn.
    expect(result.terminate).not.toBe(true)
  })

  test("an allowed handoff registers and terminates as before", async () => {
    const sink = gatedSink(["planner", "builder", "auditor"], { gateMessage: null })
    const tool = createHandoffToolDefinition(sink, "builder")
    const result = await tool.execute("tc1", { to: "auditor" }, undefined, undefined, {} as any)
    expect(sink.registrations).toEqual([{ from: "builder", to: "auditor" }])
    expect(result.terminate).toBe(true)
  })
})
