// route_decision tool — execute-path contract (supervised routing, phase 1).
// The stateless runner itself needs a live model; what's testable in isolation
// is the tool's decision capture: verdict validation, transfer target checks,
// the one-decision rule, and terminate semantics (F6 class).

import { describe, expect, test } from "vitest"
import { createRouteDecisionToolDefinition, type SupervisorVerdict } from "../route-supervisor.js"

function harness(validTargets: string[]) {
  let decision: SupervisorVerdict | null = null
  const tool = createRouteDecisionToolDefinition(
    validTargets,
    (v) => { decision = v },
    () => decision,
  )
  return {
    tool,
    get decision() { return decision },
    exec: (params: Record<string, unknown>) =>
      tool.execute("tc-1", params as never, undefined as never, undefined as never, undefined as never),
  }
}

const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content[0]?.text ?? ""

describe("route_decision tool", () => {
  test("accept captures the verdict and terminates the turn", async () => {
    const h = harness(["builder", "tester"])
    const res = await h.exec({ verdict: "accept", reason: "right next seat" })
    expect(h.decision).toEqual({ verdict: "accept", reason: "right next seat" })
    expect((res as { terminate?: boolean }).terminate).toBe(true)
  })

  test("refuse captures verdict + reason (no targetIds needed)", async () => {
    const h = harness(["builder"])
    await h.exec({ verdict: "refuse", reason: "auditor must see src changes first" })
    expect(h.decision).toEqual({ verdict: "refuse", reason: "auditor must see src changes first" })
  })

  test("transfer keeps only valid target ids", async () => {
    const h = harness(["builder", "auditor"])
    await h.exec({ verdict: "transfer", targetIds: ["auditor", "ghost"], reason: "review first" })
    expect(h.decision).toEqual({ verdict: "transfer", targetIds: ["auditor"], reason: "review first" })
  })

  test("transfer de-dupes repeated target ids (F1)", async () => {
    const h = harness(["builder", "auditor"])
    await h.exec({ verdict: "transfer", targetIds: ["auditor", "auditor", "auditor"], reason: "review" })
    expect(h.decision).toEqual({ verdict: "transfer", targetIds: ["auditor"], reason: "review" })
  })

  test("transfer without any valid target is a correctable error (no terminate, nothing captured)", async () => {
    const h = harness(["builder"])
    const res = await h.exec({ verdict: "transfer", targetIds: ["ghost"], reason: "x" })
    expect(h.decision).toBeNull()
    expect((res as { terminate?: boolean }).terminate).toBeUndefined()
    expect(text(res as never)).toContain("transfer needs at least one valid targetId")
  })

  test("transfer with no targetIds at all is the same correctable error", async () => {
    const h = harness(["builder"])
    await h.exec({ verdict: "transfer", reason: "x" })
    expect(h.decision).toBeNull()
  })

  test("one decision per proposal — second call terminates without overwriting the first", async () => {
    const h = harness(["builder", "tester"])
    await h.exec({ verdict: "accept", reason: "first" })
    const res = await h.exec({ verdict: "refuse", reason: "second thoughts" })
    expect(h.decision).toEqual({ verdict: "accept", reason: "first" })
    expect(text(res as never)).toContain("already decided (accept)")
    // Terminates (unlike the handoff double-call error): a decision exists,
    // there is nothing left to retry in this micro-turn.
    expect((res as { terminate?: boolean }).terminate).toBe(true)
  })

  test("recovers in-turn: failed transfer then a valid accept still captures", async () => {
    const h = harness(["builder"])
    await h.exec({ verdict: "transfer", targetIds: ["ghost"], reason: "x" })
    await h.exec({ verdict: "accept", reason: "fine as proposed" })
    expect(h.decision).toEqual({ verdict: "accept", reason: "fine as proposed" })
  })

  test("schema exposes the three verdicts and valid ids in descriptions", () => {
    const h = harness(["builder", "tester"])
    const schema = h.tool.parameters as { properties: Record<string, { anyOf?: unknown[]; description?: string }> }
    expect(schema.properties.verdict.anyOf).toHaveLength(3)
    expect(schema.properties.targetIds?.description).toContain("builder, tester")
  })
})
