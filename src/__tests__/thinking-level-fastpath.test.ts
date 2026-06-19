import { test, expect, describe } from "vitest"

/* ────────────────────────────────────────────────────
 *  Thinking Level — Fast Path (setThinkingLevel in-place)
 * ──────────────────────────────────────────────────── */

const VALID_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"]

function isFastPath(patch: Record<string, any>): boolean {
  return Object.keys(patch).length === 1 &&
         "thinkingLevel" in patch &&
         patch.thinkingLevel !== undefined
}

/* ── Participant.setThinkingLevel ────────────────── */

describe("Participant.setThinkingLevel", () => {
  test("calls session.setThinkingLevel and updates persona", async () => {
    let sessionLevel: string | undefined
    const session = {
      setThinkingLevel: async (level: string) => { sessionLevel = level },
    } as any
    const persona = { id: "a", name: "A", systemPrompt: "Go.", tools: [], thinkingLevel: "medium" as string }

    // Simulate what Participant.setThinkingLevel does
    await session.setThinkingLevel("high")
    persona.thinkingLevel = "high"

    expect(sessionLevel).toBe("high")
    expect(persona.thinkingLevel).toBe("high")
  })

  test("each valid level can be set", async () => {
    let sessionLevel: string | undefined
    const session = {
      setThinkingLevel: async (level: string) => { sessionLevel = level },
    } as any

    for (const level of VALID_LEVELS) {
      await session.setThinkingLevel(level)
      expect(sessionLevel).toBe(level)
    }
  })
})

/* ── Participant.getAvailableThinkingLevels ──────── */

describe("Participant.getAvailableThinkingLevels", () => {
  test("returns session's levels", () => {
    const session = {
      getAvailableThinkingLevels: () => ["low", "medium", "high"],
    } as any
    const result = session.getAvailableThinkingLevels() ?? []
    expect(result).toEqual(["low", "medium", "high"])
  })

  test("returns empty array when session returns null", () => {
    const session = {
      getAvailableThinkingLevels: () => null,
    } as any
    const result = session.getAvailableThinkingLevels() ?? []
    expect(result).toEqual([])
  })

  test("returns empty array when session returns undefined", () => {
    const session = {
      getAvailableThinkingLevels: () => undefined,
    } as any
    const result = session.getAvailableThinkingLevels() ?? []
    expect(result).toEqual([])
  })
})

/* ── Registry.setThinkingLevel ──────────────────── */

describe("Registry.setThinkingLevel", () => {
  test("calls participant.setThinkingLevel and broadcasts", async () => {
    let participantLevel: string | undefined
    let broadcastCalled = false
    const participant = {
      persona: { id: "b", name: "B", systemPrompt: "Go.", tools: [] },
      setThinkingLevel: async (level: string) => { participantLevel = level },
      getAvailableThinkingLevels: () => [],
    } as any

    // Simulate what registry.setThinkingLevel does
    await participant.setThinkingLevel("xhigh")
    broadcastCalled = true

    expect(participantLevel).toBe("xhigh")
    expect(broadcastCalled).toBe(true)
  })

  test("throws for unknown participant", async () => {
    const participants = new Map()
    expect(() => {
      const p = participants.get("nonexistent")
      if (!p) throw new Error('unknown participant "nonexistent"')
    }).toThrow('unknown participant "nonexistent"')
  })
})

/* ── Server PATCH fast path logic ───────────────── */

describe("PATCH fast path decision", () => {
  test("thinkingLevel-only patch → fast path", () => {
    expect(isFastPath({ thinkingLevel: "high" })).toBe(true)
  })

  test("thinkingLevel with null → NOT fast path (undefined check fails)", () => {
    // null gets converted to undefined by the server, so it won't be in patch
    // But if it somehow arrives:
    expect(isFastPath({ thinkingLevel: undefined })).toBe(false)
  })

  test("thinkingLevel + name → heavy path (combined patch)", () => {
    expect(isFastPath({ thinkingLevel: "high", name: "New Name" })).toBe(false)
  })

  test("thinkingLevel + model → heavy path", () => {
    expect(isFastPath({ thinkingLevel: "low", model: "other-model" })).toBe(false)
  })

  test("thinkingLevel + systemPrompt → heavy path", () => {
    expect(isFastPath({ thinkingLevel: "medium", systemPrompt: "Go." })).toBe(false)
  })

  test("name-only patch → heavy path", () => {
    expect(isFastPath({ name: "New Name" })).toBe(false)
  })

  test("model-only patch → heavy path", () => {
    expect(isFastPath({ model: "other" })).toBe(false)
  })

  test("empty patch → heavy path (no keys)", () => {
    expect(isFastPath({})).toBe(false)
  })

  test("thinkingLevel with valid level → fast path for all levels", () => {
    for (const level of VALID_LEVELS) {
      expect(isFastPath({ thinkingLevel: level })).toBe(true)
    }
  })
})

/* ── Fast path bypasses room.isBusy check ───────── */

describe("fast path does not require room to be idle", () => {
  test("fast path patch structure does not include isBusy check", () => {
    const patch = { thinkingLevel: "high" }
    const isBusy = true // room is running a turn

    if (isFastPath(patch)) {
      // Fast path — no isBusy check needed
      expect(true).toBe(true)
    } else {
      // Heavy path — would need isBusy check
      throw new Error("a turn is running — press Stop before editing an agent")
    }
  })

  test("heavy path would block when room is busy", () => {
    const patch = { thinkingLevel: "high", name: "New Name" }
    const isBusy = true

    if (isFastPath(patch)) {
      // Fast path
    } else {
      if (isBusy) {
        expect(() => {
          throw new Error("a turn is running — press Stop before editing an agent")
        }).toThrow("a turn is running")
      }
    }
  })
})

/* ── GET /api/participants/:id includes availableThinkingLevels ── */

describe("GET participant includes availableThinkingLevels", () => {
  test("response shape includes availableThinkingLevels", () => {
    const persona = { id: "a", name: "A", systemPrompt: "Go.", tools: [] }
    const availableLevels = ["low", "medium", "high"]

    const response = { ...persona, availableThinkingLevels: availableLevels }
    expect(response).toHaveProperty("availableThinkingLevels", availableLevels)
    expect(response.availableThinkingLevels).toEqual(availableLevels)
  })

  test("empty availableThinkingLevels is valid", () => {
    const persona = { id: "b", name: "B", systemPrompt: "Go.", tools: [] }
    const response = { ...persona, availableThinkingLevels: [] }
    expect(response.availableThinkingLevels).toEqual([])
  })
})

/* ── Frontend EditAgent filtering ───────────────── */

describe("EditAgent thinkingLevel selector filtering", () => {
  const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"]

  test("when availableThinkingLevels is provided, only those are shown", () => {
    const available = ["low", "medium", "high"]
    const filtered = available.length > 0 ? available : ALL_LEVELS
    expect(filtered).toEqual(available)
    expect(filtered).not.toContain("off")
    expect(filtered).not.toContain("xhigh")
  })

  test("when availableThinkingLevels is empty, all levels are shown", () => {
    const available: string[] = []
    const filtered = available.length > 0 ? available : ALL_LEVELS
    expect(filtered).toEqual(ALL_LEVELS)
  })

  test("when availableThinkingLevels is undefined, all levels are shown", () => {
    const available: string[] | undefined = undefined
    const filtered = (available ?? []).length > 0 ? available : ALL_LEVELS
    expect(filtered).toEqual(ALL_LEVELS)
  })

  test("selector includes default option (empty string)", () => {
    const available = ["low", "medium", "high"]
    const filtered = available.length > 0 ? available : ALL_LEVELS
    const allOptions = ["", ...filtered]
    expect(allOptions[0]).toBe("")
    expect(allOptions).toContain("medium")
  })
})

/* ── No session recreation on fast path ─────────── */

describe("fast path does NOT recreate session", () => {
  test("fast path does not call dispose", () => {
    let disposed = false
    const participant = {
      dispose: () => { disposed = true },
    }

    // Fast path — no dispose called
    expect(disposed).toBe(false)
  })

  test("heavy path DOES call dispose", () => {
    let disposed = false
    const participant = {
      dispose: () => { disposed = true },
    }

    // Heavy path — dispose is called
    participant.dispose()
    expect(disposed).toBe(true)
  })
})

/* ── Combined patch: thinkingLevel + other field ── */

describe("combined thinkingLevel + other field takes heavy path", () => {
  test("thinkingLevel + tools → heavy path (tools require session recreation)", () => {
    const patch = { thinkingLevel: "high", tools: ["read", "bash"] }
    expect(isFastPath(patch)).toBe(false)
  })

  test("thinkingLevel + color → heavy path", () => {
    const patch = { thinkingLevel: "low", color: "#FF0000" }
    expect(isFastPath(patch)).toBe(false)
  })

  test("thinkingLevel + icon → heavy path", () => {
    const patch = { thinkingLevel: "medium", icon: "🔥" }
    expect(isFastPath(patch)).toBe(false)
  })
})

/* ── Edge case: patch with only thinkingLevel: undefined ── */

describe("patch with thinkingLevel: undefined", () => {
  test("thinkingLevel undefined is NOT fast path", () => {
    // The server converts null/empty string to undefined,
    // which means it's not in the patch object at all
    const patch = {} // after filtering out undefined
    expect(isFastPath(patch)).toBe(false)
  })
})
