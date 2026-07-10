// Turn-control tools must declare executionMode: "sequential".
//
// pi's agent loop (pi-agent-core agent-loop.js) executes a batch's tool calls
// in PARALLEL unless at least the involved tool declares itself sequential —
// the strategy picker reads `tool.executionMode === "sequential"` from the
// definition. Every turn-control tool guards its own state with a
// peek-then-register pattern (one handoff per turn, one route_decision per
// proposal); under parallel execution those guards are TOCTOU races: two
// calls in one batch both peek before either registers, and both pass.
//
// Observed live 2026-07-10 23:48 (session mrff3qwe, entry 6): builder called
// handoff(tester) then handoff(auditor) in one batch, BOTH returned ok, the
// second silently won, and the auditor opened its turn with "the builder said
// '@tester' but control came to me". This contract test pins the fix: if a
// future edit drops the flag, the race comes back with no failing unit test —
// this one is it.

import { describe, expect, it } from "vitest"
import { createHandoffToolDefinition } from "../custom-tools/handoff.js"
import { createAskOrchestratorToolDefinition } from "../custom-tools/ask-orchestrator.js"
import { createAskUserToolDefinition } from "../sandbox-tools.js"
import { createRouteDecisionToolDefinition } from "../route-supervisor.js"
import type { HandoffSink } from "../types.js"

const sink: HandoffSink = {
  activeIds: () => ["planner", "builder", "tester"],
  register: () => {},
  peekHandoff: () => undefined,
}

describe("turn-control tools serialize within a batch", () => {
  it("handoff declares executionMode sequential", () => {
    const def = createHandoffToolDefinition(sink, "builder")
    expect(def.executionMode).toBe("sequential")
  })

  it("ask_user declares executionMode sequential", () => {
    expect(createAskUserToolDefinition().executionMode).toBe("sequential")
  })

  it("route_decision declares executionMode sequential", () => {
    const def = createRouteDecisionToolDefinition(["tester"], () => {}, () => null)
    expect(def.executionMode).toBe("sequential")
  })

  it("ask_orchestrator declares executionMode sequential", () => {
    const link = { ask: async () => "answer" } as never
    const def = createAskOrchestratorToolDefinition(link, "builder")
    expect(def.executionMode).toBe("sequential")
  })
})
