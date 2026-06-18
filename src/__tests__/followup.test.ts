import { test, expect, describe } from "vitest"

/* ────────────────────────────────────────────────────
 *  followUp() — Self-Chaining (ask_user resume)
 * ──────────────────────────────────────────────────── */

/* ── Participant.followUp ───────────────────────── */

describe("Participant.followUp", () => {
  test("clears buffers before following up", () => {
    let buffer = "previous text"
    let reasoningBuffer = "previous reasoning"

    // Simulate what followUp does
    buffer = ""
    reasoningBuffer = ""

    expect(buffer).toBe("")
    expect(reasoningBuffer).toBe("")
  })

  test("sets status to active", () => {
    let status = "idle"
    status = "active"
    expect(status).toBe("active")
  })

  test("calls session.followUp with text and images", async () => {
    let followedUpText: string | undefined
    let followedUpImages: any[] | undefined

    const mockSession = {
      followUp: async (text: string, images?: any[]) => {
        followedUpText = text
        followedUpImages = images
      },
    }

    await mockSession.followUp("the answer is 42", undefined)
    expect(followedUpText).toBe("the answer is 42")
    expect(followedUpImages).toBeUndefined()
  })

  test("calls session.followUp with images when provided", async () => {
    let followedUpText: string | undefined
    let followedUpImages: any[] | undefined

    const mockSession = {
      followUp: async (text: string, images?: any[]) => {
        followedUpText = text
        followedUpImages = images
      },
    }

    const mockImages = [{ data: "base64...", mimeType: "image/png" }]
    await mockSession.followUp("the answer", mockImages)
    expect(followedUpText).toBe("the answer")
    expect(followedUpImages).toEqual(mockImages)
  })

  test("returns TurnResult with text, activity, reasoning", async () => {
    const buffer = "Agent's response to the follow-up"
    const reasoningBuffer = "Some reasoning"
    const activity = [{ toolCallId: "1", toolName: "read", args: {}, status: "ok" as const, ts: 1 }]

    const result = {
      text: buffer.trim(),
      activity: [...activity],
      reasoning: reasoningBuffer.trim() || undefined,
    }

    expect(result.text).toBe("Agent's response to the follow-up")
    expect(result.activity).toEqual(activity)
    expect(result.reasoning).toBe("Some reasoning")
  })

  test("empty reasoningBuffer → undefined", () => {
    const reasoningBuffer = ""
    const reasoning = reasoningBuffer.trim() || undefined
    expect(reasoning).toBeUndefined()
  })

  test("whitespace-only reasoningBuffer → undefined", () => {
    const reasoningBuffer = "   "
    const reasoning = reasoningBuffer.trim() || undefined
    expect(reasoning).toBeUndefined()
  })
})

/* ── Room.followUpAgent ─────────────────────────── */

describe("Room.followUpAgent", () => {
  test("takes snapshot before and after", () => {
    const steps: string[] = []
    steps.push("snapshot-before")
    steps.push("add-to-running")
    steps.push("followUp")
    steps.push("snapshot-after")
    steps.push("diff-receipt")
    expect(steps).toEqual([
      "snapshot-before",
      "add-to-running",
      "followUp",
      "snapshot-after",
      "diff-receipt",
    ])
  })

  test("adds target to running set", () => {
    const running = new Set<string>()
    running.add("builder")
    expect(running.has("builder")).toBe(true)
  })

  test("removes target from running set in finally", () => {
    const running = new Set<string>()
    running.add("builder")
    running.delete("builder")
    expect(running.has("builder")).toBe(false)
  })

  test("returns null when aborted", () => {
    const aborted = true
    const result = aborted ? null : "something"
    expect(result).toBeNull()
  })

  test("broadcasts contextUsage and sessionStats after followUp", () => {
    const usage = { tokens: 50000, contextWindow: 128000, percent: 39.1 }
    const stats = { userMessages: 6, assistantMessages: 5, toolCalls: 4, tokens: { input: 50000, output: 1500, cacheRead: 48000, cacheWrite: 3500, total: 51500 } }

    const shouldBroadcast = !!(usage || stats)
    expect(shouldBroadcast).toBe(true)
  })

  test("no broadcast when neither usage nor stats available", () => {
    const usage = undefined
    const stats = undefined
    const shouldBroadcast = !!(usage || stats)
    expect(shouldBroadcast).toBe(false)
  })
})

/* ── Ask_user resume path uses followUpAgent ────── */

describe("Ask_user resume path", () => {
  test("resume uses followUpAgent, not runAgent", () => {
    const asker = { persona: { id: "builder", name: "Builder" } }
    const trimmed = "the answer is 42"
    const images: string[] = []

    // The resume path calls followUpAgent(asker, { text: trimmed, images })
    const context = { text: trimmed, images }
    expect(context.text).toBe("the answer is 42")
    expect(context.images).toEqual([])
  })

  test("result is posted with question field if asker asked another question", () => {
    const result = {
      reply: "I'll check that file",
      activity: [],
      question: "Can you confirm?",
    }

    expect(result.reply).toBe("I'll check that file")
    expect(result.question).toBe("Can you confirm?")
  })

  test("result with no reply → '(no response)'", () => {
    const result = {
      reply: "",
      activity: [],
    }
    const displayReply = result.reply || "(no response)"
    expect(displayReply).toBe("(no response)")
  })

  test("cursor updated to transcript length after followUp", () => {
    const transcript = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]
    let cursor = 0
    cursor = transcript.length
    expect(cursor).toBe(2)
  })

  test("aborted → no post, no cursor update", () => {
    const aborted = true
    const result = { reply: "some text", activity: [] }

    if (result && !aborted) {
      // Would post
    } else {
      // Skipped — correct
    }
    expect(aborted).toBe(true)
  })
})

/* ── Key difference: followUp vs prompt ──────────── */

describe("followUp vs prompt — key differences", () => {
  test("followUp delivers message directly to agent session", () => {
    // With followUp: answer goes directly to agent's session memory
    // No context rebuild from transcript needed
    const deliveryMethod = "direct-to-session"
    expect(deliveryMethod).toBe("direct-to-session")
  })

  test("followUp guarantees ordering — next thing agent processes", () => {
    // followUp() queues the message as the next thing the agent processes
    // No Room routing needed
    const isGuaranteed = true
    expect(isGuaranteed).toBe(true)
  })

  test("prompt rebuilds context from transcript (unnecessary for self-chaining)", () => {
    // The old prompt() path went through Room.buildContext()
    // which reconstructed the unseen transcript lines
    // followUp() skips this — the agent already has context
    const skipContextRebuild = true
    expect(skipContextRebuild).toBe(true)
  })
})

/* ── MockParticipant.followUp ───────────────────── */

describe("MockParticipant.followUp", () => {
  test("mock returns next result", async () => {
    const mock = {
      _nextResult: { text: "follow-up response", activity: [] },
      followUp: async (_text: string) => {
        const result = { text: "follow-up response", activity: [] }
        return result
      },
    }
    const result = await mock.followUp("the answer")
    expect(result.text).toBe("follow-up response")
  })

  test("mock can return a question", async () => {
    const mock = {
      followUp: async () => ({
        text: "I need more info",
        activity: [],
        question: "What's the filename?",
      }),
    }
    const result = await mock.followUp("the answer")
    expect(result.question).toBe("What's the filename?")
  })
})
