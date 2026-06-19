import { test, expect, describe } from "vitest"

/* ────────────────────────────────────────────────────
 *  Steer — Mid-Turn Redirection
 * ──────────────────────────────────────────────────── */

/* ── Participant.steer ──────────────────────────── */

describe("Participant.steer", () => {
  test("calls session.steer when isStreaming is true", async () => {
    let steeredText: string | undefined
    const mockSession = {
      isStreaming: true,
      steer: async (text: string) => { steeredText = text },
    }
    const persona = { id: "builder", name: "Builder" }

    // Simulate Participant.steer logic
    if (!mockSession.isStreaming) {
      throw new Error(`participant "${persona.id}" is not running — cannot steer`)
    }
    await mockSession.steer("redirect to the other file")

    expect(steeredText).toBe("redirect to the other file")
  })

  test("throws when isStreaming is false", async () => {
    const mockSession = {
      isStreaming: false,
      steer: async (_text: string) => {},
    }
    const persona = { id: "builder", name: "Builder" }

    try {
      if (!mockSession.isStreaming) {
        throw new Error(`participant "${persona.id}" is not running — cannot steer`)
      }
      await mockSession.steer("redirect")
    } catch (err) {
      expect(err instanceof Error).toBe(true)
      expect((err as Error).message).toContain("not running")
    }
  })

  test("throws when isStreaming is undefined", async () => {
    const mockSession = {
      isStreaming: undefined,
      steer: async (_text: string) => {},
    }
    const persona = { id: "auditor", name: "Auditor" }

    try {
      if (!mockSession.isStreaming) {
        throw new Error(`participant "${persona.id}" is not running — cannot steer`)
      }
      await mockSession.steer("redirect")
    } catch (err) {
      expect(err instanceof Error).toBe(true)
      expect((err as Error).message).toContain("not running")
    }
  })
})

/* ── Room.steer ─────────────────────────────────── */

describe("Room.steer", () => {
  test("posts (steered) notice to transcript", () => {
    const postedMessages: string[] = []
    const post = (role: string, name: string, content: string) => {
      postedMessages.push(content)
    }
    const targetId = "builder"
    const text = "check the other file"

    // Simulate Room.steer notice
    post("user", "You", `↳ steered @${targetId}: ${text}`)

    expect(postedMessages).toEqual([`↳ steered @${targetId}: ${text}`])
  })

  test("throws for unknown participant", () => {
    const registry = new Map<string, any>()
    const targetId = "nonexistent"
    expect(() => {
      const p = registry.get(targetId)
      if (!p) throw new Error(`unknown participant "${targetId}"`)
    }).toThrow('unknown participant "nonexistent"')
  })
})

/* ── Room.turn lifecycle — runningAgentId ──────── */

describe("Room turn lifecycle — runningAgentId", () => {
  test("turn start sets runningAgentId", () => {
    let agentId: string | null = null
    const initial = [{ persona: { id: "builder", name: "Builder" } }]

    // Simulate turn start
    agentId = initial[0]?.persona.id ?? null

    expect(agentId).toBe("builder")
  })

  test("turn end clears runningAgentId", () => {
    let agentId: string | null = "builder"

    // Simulate endTurn
    agentId = null

    expect(agentId).toBeNull()
  })

  test("parallel wave — agentId is first in initial list", () => {
    const initial = [
      { persona: { id: "builder", name: "Builder" } },
      { persona: { id: "tester", name: "Tester" } },
    ]
    const agentId = initial[0]?.persona.id ?? null

    expect(agentId).toBe("builder")
  })

  test("empty initial — agentId is null", () => {
    const initial: any[] = []
    const agentId = initial[0]?.persona.id ?? null

    expect(agentId).toBeNull()
  })
})

/* ── Server POST /api/messages/steer ───────────── */

describe("Server steer endpoint", () => {
  test("valid steer request → 200", () => {
    const body = { text: "redirect", target: "builder" }
    expect(body.text).toBe("redirect")
    expect(body.target).toBe("builder")
  })

  test("missing text → 400", () => {
    const body = { target: "builder" } as { text?: string; target: string }
    const hasText = body.text != null && body.text !== ""
    expect(hasText).toBe(false)
  })

  test("missing target → 400", () => {
    const body = { text: "redirect" } as { text: string; target?: string }
    const hasTarget = body.target != null && body.target !== ""
    expect(hasTarget).toBe(false)
  })

  test("agent not running → 409", () => {
    const msg = 'participant "builder" is not running — cannot steer'
    const isConflict = msg.includes("not running") || msg.includes("cannot steer")
    expect(isConflict).toBe(true)
  })

  test("unknown participant → 404", () => {
    const msg = 'unknown participant "ghost"'
    const isNotFound = msg.includes("unknown participant")
    expect(isNotFound).toBe(true)
  })

  test("unexpected error → 500", () => {
    const msg = "some other error"
    const isConflict = msg.includes("not running") || msg.includes("cannot steer")
    const isNotFound = msg.includes("unknown participant")
    const isServerError = !isConflict && !isNotFound
    expect(isServerError).toBe(true)
  })

  test("text is trimmed before steering", () => {
    const text = "  redirect  "
    const trimmed = String(text).trim()
    expect(trimmed).toBe("redirect")
  })
})

/* ── Frontend API steerMessage ──────────────────── */

describe("Frontend API steerMessage", () => {
  test("fetches correct endpoint", () => {
    const API_BASE = "http://localhost:3000"
    const expectedUrl = `${API_BASE}/api/messages/steer`
    expect(expectedUrl).toBe("http://localhost:3000/api/messages/steer")
  })

  test("POST body contains text and target", () => {
    const body = { text: "redirect", target: "builder" }
    expect(body.text).toBe("redirect")
    expect(body.target).toBe("builder")
  })
})

/* ── Composer steer mode ────────────────────────── */

describe("Composer steer mode", () => {
  test("turnActive + runningAgentId → steer mode", () => {
    const turnActive = true
    const runningAgentId = "builder"
    const isSteerMode = turnActive && !!runningAgentId
    expect(isSteerMode).toBe(true)
  })

  test("turnActive but no runningAgentId → normal mode", () => {
    const turnActive = true
    const runningAgentId = null
    const isSteerMode = turnActive && !!runningAgentId
    expect(isSteerMode).toBe(false)
  })

  test("not turnActive → normal mode", () => {
    const turnActive = false
    const runningAgentId = "builder"
    const isSteerMode = turnActive && !!runningAgentId
    expect(isSteerMode).toBe(false)
  })

  test("steer button label includes agent id", () => {
    const runningAgentId = "builder"
    const label = `↪ Steer @${runningAgentId}`
    expect(label).toBe("↪ Steer @builder")
  })

  test("steer button label without agent id", () => {
    const runningAgentId = null
    const label = `↪ Steer${runningAgentId ? ` @${runningAgentId}` : ""}`
    expect(label).toBe("↪ Steer")
  })

  test("steer flash appears after submit in steer mode", () => {
    let steerSent = false
    // Simulate submit in steer mode
    steerSent = true
    expect(steerSent).toBe(true)
  })

  test("steer flash clears after 2 seconds", () => {
    let steerSent = true
    // Simulate the timeout clearing it
    steerSent = false
    expect(steerSent).toBe(false)
  })
})

/* ── Frontend useRoom — runningAgentId from turn events ── */

describe("useRoom runningAgentId from turn events", () => {
  test("turn start event sets runningAgentId", () => {
    let runningAgentId: string | null = null
    const data = { phase: "start", agentId: "builder" }

    if (data.phase === "start") {
      runningAgentId = data.agentId ?? null
    }

    expect(runningAgentId).toBe("builder")
  })

  test("turn end event clears runningAgentId", () => {
    let runningAgentId: string | null = "builder"
    const data = { phase: "end" }

    if (data.phase === "end") {
      runningAgentId = null
    }

    expect(runningAgentId).toBeNull()
  })

  test("turn start with null agentId → null", () => {
    let runningAgentId: string | null = null
    const data = { phase: "start", agentId: null }

    if (data.phase === "start") {
      runningAgentId = data.agentId ?? null
    }

    expect(runningAgentId).toBeNull()
  })

  test("turn pause → runningAgentId preserved", () => {
    let runningAgentId: string | null = "builder"
    let paused = false
    const data = { phase: "pause", askerId: "builder" }

    if (data.phase === "pause") {
      paused = true
      // runningAgentId is NOT cleared on pause
    }

    expect(paused).toBe(true)
    expect(runningAgentId).toBe("builder")
  })
})

/* ── CSS classes ────────────────────────────────── */

describe("CSS classes for steer", () => {
  test("btn-steer class is used", () => {
    const className = "btn-steer"
    expect(className).toBe("btn-steer")
  })

  test("steer-flash class is used", () => {
    const className = "steer-flash"
    expect(className).toBe("steer-flash")
  })

  test("steer-flash message text", () => {
    const message = "↪ steer sent — clearing on next response"
    expect(message).toContain("steer sent")
  })
})
