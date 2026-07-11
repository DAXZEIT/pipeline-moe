import { describe, expect, test } from "vitest"
import { ReasoningBudget, reasoningBudgetFor, exhaustedTrace } from "../reasoning-budget.js"

describe("reasoningBudgetFor", () => {
  test("local ref gets a budget", () => {
    expect(reasoningBudgetFor("local/Qwopus3.6-27B.gguf", 25_000, 2)).toBeInstanceOf(ReasoningBudget)
  })

  test("cloud ref gets none — deep reasoners spend legitimately", () => {
    expect(reasoningBudgetFor("anthropic/claude-sonnet-5", 25_000, 2)).toBeNull()
  })

  test("unknown ref counts as local (conservative: with the safety net)", () => {
    expect(reasoningBudgetFor(null, 25_000, 2)).toBeInstanceOf(ReasoningBudget)
  })

  test("0 chars disables entirely", () => {
    expect(reasoningBudgetFor("local/x.gguf", 0, 2)).toBeNull()
  })
})

describe("ReasoningBudget.consume", () => {
  test("fires true exactly once when the grant crosses the budget", () => {
    const b = new ReasoningBudget(100, 2)
    expect(b.consume(60)).toBe(false)
    expect(b.consume(60)).toBe(true) // crossed 100
    expect(b.breached).toBe(true)
    // further deltas while breached: no re-fire (abort already requested)
    expect(b.consume(500)).toBe(false)
  })

  test("stays quiet under budget", () => {
    const b = new ReasoningBudget(1000, 2)
    expect(b.consume(999)).toBe(false)
    expect(b.breached).toBe(false)
  })
})

describe("ReasoningBudget.nextCheckpoint", () => {
  const breach = (b: ReasoningBudget) => {
    b.consume(10_000_000)
  }

  test("first two checkpoints offer continue, the third is final, then null", () => {
    const b = new ReasoningBudget(100, 2)

    breach(b)
    const c1 = b.nextCheckpoint("tester")!
    expect(c1.final).toBe(false)
    expect(c1.message).toContain("reasoning checkpoint 1/2")
    expect(c1.message).toContain("continue")
    expect(c1.trace).toContain("🧠 @tester")
    expect(b.breached).toBe(false) // re-armed

    breach(b)
    const c2 = b.nextCheckpoint("tester")!
    expect(c2.final).toBe(false)
    expect(c2.message).toContain("checkpoint 2/2")

    breach(b)
    const c3 = b.nextCheckpoint("tester")!
    expect(c3.final).toBe(true)
    expect(c3.message).toContain("final reasoning checkpoint")
    // the final message offers exactly two exits — no more continue grant
    expect(c3.message).not.toContain("(a) continue")

    breach(b)
    expect(b.nextCheckpoint("tester")).toBeNull() // hard end
  })

  test("checkpoint offers all three exits and names the escalation seats", () => {
    const b = new ReasoningBudget(100, 2)
    breach(b)
    const c = b.nextCheckpoint("tester")!
    expect(c.message).toContain("answer now")
    expect(c.message).toContain("@planner")
    expect(c.message).toContain("ask_user")
  })

  test("re-armed grant counts fresh — a continue that stays under budget never re-breaches", () => {
    const b = new ReasoningBudget(100, 2)
    breach(b)
    b.nextCheckpoint("tester")
    expect(b.consume(99)).toBe(false)
    expect(b.breached).toBe(false)
  })

  test("maxContinues 0 → first checkpoint is already the final one", () => {
    const b = new ReasoningBudget(100, 0)
    breach(b)
    const c = b.nextCheckpoint("x")!
    expect(c.final).toBe(true)
    breach(b)
    expect(b.nextCheckpoint("x")).toBeNull()
  })
})

test("exhaustedTrace names the seat and the outcome", () => {
  const t = exhaustedTrace("tester")
  expect(t).toContain("@tester")
  expect(t).toContain("turn ended")
  expect(t.startsWith("⚠")).toBe(true)
})

test("messages use positive phrasing — no forbidden-concept priming", () => {
  const b = new ReasoningBudget(100, 2)
  b.consume(200)
  const c = b.nextCheckpoint("x")!
  for (const bad of ["don't", "do not", "stop overthinking", "never"]) {
    expect(c.message.toLowerCase()).not.toContain(bad)
  }
})
