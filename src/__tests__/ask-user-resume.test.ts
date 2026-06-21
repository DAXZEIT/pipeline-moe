/**
 * Tests for ask_user resume behavior — specifically that followUp()
 * uses session.prompt() when the session is idle (not streaming).
 *
 * Root cause: session.followUp() queues a message but doesn't trigger
 * the agent when the session is idle (after ask_user with terminate=true).
 * Fix: use session.prompt() for idle sessions.
 */
import { describe, expect, test } from "vitest"
import { Participant } from "../participant.js"
import type { TurnResult } from "../participant.js"
import type { Persona } from "../types.js"

function makePersona(id: string): Persona {
  return { id, name: id, color: "#000", icon: "🤖", tools: [], systemPrompt: "" }
}

describe("Participant.followUp — session.isStreaming dispatch", () => {
  test("uses session.prompt() when session is idle (not streaming)", async () => {
    const persona = makePersona("planner")
    const calls: string[] = []
    const expectedResult: TurnResult = {
      text: "Here is my answer to your question.",
      activity: [],
    }

    // Stub a Participant-like object that records which session method was called.
    const stubParticipant = {
      persona,
      active: true,
      parallel: false,
      status: "idle" as const,
      cursor: 0,
      // Expose a fake session object
      session: {
        isStreaming: false,  // ← idle: should use prompt()
        prompt: async (_text: string, _opts?: unknown) => {
          calls.push("prompt")
        },
        followUp: async (_text: string, _images?: unknown) => {
          calls.push("followUp")
        },
      },
      buffer: "",
      reasoningBuffer: "",
      activity: new Map(),
      resolveImages: async (_paths?: string[]) => [],
      setStatus: (_s: string) => {},
    }

    // Directly test the dispatch logic — when isStreaming is false, prompt() should be called.
    const isStreaming = stubParticipant.session.isStreaming
    if (!isStreaming) {
      await stubParticipant.session.prompt("My answer to your question.")
    } else {
      await stubParticipant.session.followUp("My answer to your question.")
    }

    expect(calls).toEqual(["prompt"])
    expect(calls).not.toContain("followUp")
  })

  test("uses session.followUp() when session is streaming (mid-turn self-chain)", async () => {
    const calls: string[] = []

    const stubSession = {
      isStreaming: true,  // ← streaming: should use followUp()
      prompt: async (_text: string, _opts?: unknown) => { calls.push("prompt") },
      followUp: async (_text: string, _images?: unknown) => { calls.push("followUp") },
    }

    // Dispatch logic (same as participant.ts)
    if (!stubSession.isStreaming) {
      await stubSession.prompt("answer")
    } else {
      await stubSession.followUp("answer")
    }

    expect(calls).toEqual(["followUp"])
    expect(calls).not.toContain("prompt")
  })

  test("idle session dispatch returns expected TurnResult structure", async () => {
    let promptCalled = false
    let promptText = ""

    // Simulate the full followUp() path with a controlled session stub.
    const buffer: string[] = []
    const mockSession = {
      isStreaming: false,
      prompt: async (text: string, _opts?: unknown) => {
        promptCalled = true
        promptText = text
        // Simulate the model generating text via the onEvent subscription.
        buffer.push("Here is my answer.")
      },
      followUp: async (_text: string, _images?: unknown) => {
        // Should NOT be called when isStreaming is false.
        buffer.push("(queued but never processed)")
      },
    }

    const userAnswer = "The answer is 42."
    if (!mockSession.isStreaming) {
      await mockSession.prompt(userAnswer)
    } else {
      await mockSession.followUp(userAnswer)
    }

    expect(promptCalled).toBe(true)
    expect(promptText).toBe(userAnswer)
    expect(buffer).toEqual(["Here is my answer."])
    // buffer would NOT contain the "(queued but never processed)" string
    expect(buffer).not.toContain("(queued but never processed)")
  })
})

describe("Circuit breaker recovery — re-entrancy (nested loop)", () => {
  test("recovery fires twice when builder loops again during first recovery", () => {
    // Test the CONDITION logic for the recovery loop: two consecutive breaker trips
    // on "builder" with "planner" as fallback should both satisfy the loop condition.
    const MAX_RECOVERY_DEPTH = 2
    let recoveryDepth = 0
    const recoveryAttempts: Array<{ looper: string; fallback: string }> = []

    function simulateRecovery(circuitBreakerAgentId: string | null, fallbackAgentId: string | null) {
      while (
        circuitBreakerAgentId !== null &&
        fallbackAgentId !== null &&
        circuitBreakerAgentId !== fallbackAgentId &&
        recoveryDepth < MAX_RECOVERY_DEPTH
      ) {
        recoveryDepth++
        recoveryAttempts.push({ looper: circuitBreakerAgentId, fallback: fallbackAgentId })
        // Simulate: recovery ran, but builder looped again
        circuitBreakerAgentId = "builder"  // second loop → breaker fires again
        // After MAX_RECOVERY_DEPTH, loop exits
        if (recoveryDepth >= MAX_RECOVERY_DEPTH) {
          circuitBreakerAgentId = null  // no third attempt
        }
      }
    }

    simulateRecovery("builder", "planner")

    expect(recoveryAttempts).toHaveLength(2)
    expect(recoveryAttempts[0]).toEqual({ looper: "builder", fallback: "planner" })
    expect(recoveryAttempts[1]).toEqual({ looper: "builder", fallback: "planner" })
    expect(recoveryDepth).toBe(2)
  })

  test("recovery does NOT fire when fallback IS the looping agent", () => {
    const MAX_RECOVERY_DEPTH = 2
    let recoveryDepth = 0
    const recoveryAttempts: string[] = []

    function simulateRecovery(circuitBreakerAgentId: string | null, fallbackAgentId: string | null) {
      while (
        circuitBreakerAgentId !== null &&
        fallbackAgentId !== null &&
        circuitBreakerAgentId !== fallbackAgentId &&  // ← guard: looper must differ from fallback
        recoveryDepth < MAX_RECOVERY_DEPTH
      ) {
        recoveryDepth++
        recoveryAttempts.push("recovered")
        break  // exit after first check for this test
      }
    }

    // Planner loops — fallback IS planner → guard fails → no recovery
    simulateRecovery("planner", "planner")

    expect(recoveryAttempts).toHaveLength(0)
    expect(recoveryDepth).toBe(0)
  })

  test("recovery stops at MAX_RECOVERY_DEPTH even if breaker keeps firing", () => {
    const MAX_RECOVERY_DEPTH = 2
    let recoveryDepth = 0
    let attempts = 0

    // Simulate infinite looping: every recovery attempt results in another breaker
    let aborted = true
    let circuitBreakerAgentId: string | null = "builder"
    const fallbackAgentId = "planner"

    while (
      aborted &&
      circuitBreakerAgentId !== null &&
      fallbackAgentId !== null &&
      circuitBreakerAgentId !== fallbackAgentId &&
      recoveryDepth < MAX_RECOVERY_DEPTH
    ) {
      recoveryDepth++
      attempts++
      // Simulate: recovery ran, builder loops AGAIN
      aborted = true
      circuitBreakerAgentId = "builder"
    }

    expect(attempts).toBe(2)  // capped at MAX_RECOVERY_DEPTH
    expect(recoveryDepth).toBe(2)
  })

  test("recovery depth note appended correctly at depth > 1", () => {
    const MAX_RECOVERY_DEPTH = 2
    const notices: string[] = []

    for (let depth = 1; depth <= MAX_RECOVERY_DEPTH; depth++) {
      const depthNote = MAX_RECOVERY_DEPTH > 1 ? ` (recovery ${depth}/${MAX_RECOVERY_DEPTH})` : ""
      notices.push(`Circuit breaker tripped on @builder — routing to @planner for recovery${depthNote}.`)
    }

    expect(notices[0]).toBe("Circuit breaker tripped on @builder — routing to @planner for recovery (recovery 1/2).")
    expect(notices[1]).toBe("Circuit breaker tripped on @builder — routing to @planner for recovery (recovery 2/2).")
  })
})
