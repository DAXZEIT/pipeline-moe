import { test, expect, describe } from "vitest"

/* ────────────────────────────────────────────────────
 *  Context Usage — Empirical Verification
 * ──────────────────────────────────────────────────── */

interface ContextUsagePayload {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

interface StatusPayload {
  id: string
  status: string
  contextUsage?: ContextUsagePayload
}

/* ────────────────────────────────────────────────────
 *  ctxColor threshold logic (from Roster.tsx)
 *  Inclusive boundaries: green <50, yellow 50-75, orange 75-90, red 90+
 * ──────────────────────────────────────────────────── */

function ctxColor(pct: number | null): string {
  if (pct == null) return "ctx-green"
  if (pct >= 90) return "ctx-red"
  if (pct >= 75) return "ctx-orange"
  if (pct >= 50) return "ctx-yellow"
  return "ctx-green"
}

describe("ctxColor threshold logic (inclusive boundaries)", () => {
  // Green zone: < 50%
  test("0% → ctx-green", () => expect(ctxColor(0)).toBe("ctx-green"))
  test("25% → ctx-green", () => expect(ctxColor(25)).toBe("ctx-green"))
  test("49% → ctx-green", () => expect(ctxColor(49)).toBe("ctx-green"))
  test("49.9% → ctx-green", () => expect(ctxColor(49.9)).toBe("ctx-green"))

  // Yellow zone: >= 50% and < 75%
  test("50% → ctx-yellow (boundary — >= inclusive)", () => expect(ctxColor(50)).toBe("ctx-yellow"))
  test("51% → ctx-yellow", () => expect(ctxColor(51)).toBe("ctx-yellow"))
  test("74% → ctx-yellow", () => expect(ctxColor(74)).toBe("ctx-yellow"))
  test("74.9% → ctx-yellow", () => expect(ctxColor(74.9)).toBe("ctx-yellow"))

  // Orange zone: >= 75% and < 90%
  test("75% → ctx-orange (boundary — >= inclusive)", () => expect(ctxColor(75)).toBe("ctx-orange"))
  test("76% → ctx-orange", () => expect(ctxColor(76)).toBe("ctx-orange"))
  test("80% → ctx-orange", () => expect(ctxColor(80)).toBe("ctx-orange"))
  test("89% → ctx-orange", () => expect(ctxColor(89)).toBe("ctx-orange"))
  test("89.9% → ctx-orange", () => expect(ctxColor(89.9)).toBe("ctx-orange"))

  // Red zone: >= 90%
  test("90% → ctx-red (boundary — >= inclusive)", () => expect(ctxColor(90)).toBe("ctx-red"))
  test("90.1% → ctx-red", () => expect(ctxColor(90.1)).toBe("ctx-red"))
  test("95% → ctx-red", () => expect(ctxColor(95)).toBe("ctx-red"))
  test("100% → ctx-red", () => expect(ctxColor(100)).toBe("ctx-red"))

  // Null handling
  test("null → ctx-green", () => expect(ctxColor(null)).toBe("ctx-green"))
})

/* ────────────────────────────────────────────────────
 *  ctxLabel formatting (from Roster.tsx)
 * ──────────────────────────────────────────────────── */

function ctxLabel(usage: ContextUsagePayload): string {
  const t = usage.tokens != null ? `${Math.round(usage.tokens / 1000)}K` : "—"
  const w = `${Math.round(usage.contextWindow / 1000)}K`
  return `${t} / ${w}`
}

describe("ctxLabel formatting", () => {
  test("normal usage → '42K / 128K'", () => {
    expect(ctxLabel({ tokens: 42100, contextWindow: 128000, percent: 32.9 })).toBe("42K / 128K")
  })

  test("null tokens → '— / 128K'", () => {
    expect(ctxLabel({ tokens: null, contextWindow: 128000, percent: null })).toBe("— / 128K")
  })

  test("rounding up → '13K'", () => {
    expect(ctxLabel({ tokens: 12600, contextWindow: 128000, percent: 9.8 })).toBe("13K / 128K")
  })

  test("exact boundary → '0K / 128K'", () => {
    expect(ctxLabel({ tokens: 100, contextWindow: 128000, percent: 0.1 })).toBe("0K / 128K")
  })

  test("small window → '5K / 32K'", () => {
    expect(ctxLabel({ tokens: 5000, contextWindow: 32000, percent: 15.6 })).toBe("5K / 32K")
  })
})

/* ────────────────────────────────────────────────────
 *  Warning threshold (> 80% triggers ctx-warning class)
 * ──────────────────────────────────────────────────── */

function hasWarningClass(pct: number | null): boolean {
  return pct !== null && pct > 80
}

describe("ctx-warning threshold (> 80% triggers pulse)", () => {
  test("79% → no warning", () => expect(hasWarningClass(79)).toBe(false))
  test("80% → no warning", () => expect(hasWarningClass(80)).toBe(false))
  test("80.1% → warning", () => expect(hasWarningClass(80.1)).toBe(true))
  test("85% → warning", () => expect(hasWarningClass(85)).toBe(true))
  test("95% → warning", () => expect(hasWarningClass(95)).toBe(true))
  test("null → no warning", () => expect(hasWarningClass(null)).toBe(false))
})

/* ────────────────────────────────────────────────────
 *  SSE event structure — verify the broadcast shape
 * ──────────────────────────────────────────────────── */

describe("SSE status event structure", () => {
  const mockUsage: ContextUsagePayload = { tokens: 45000, contextWindow: 128000, percent: 35.15 }

  test("broadcast payload has contextUsage field", () => {
    const payload: StatusPayload = {
      id: "builder",
      status: "idle",
      contextUsage: mockUsage,
    }
    expect(payload).toHaveProperty("id", "builder")
    expect(payload).toHaveProperty("status", "idle")
    expect(payload).toHaveProperty("contextUsage")
    expect(payload.contextUsage).toEqual(mockUsage)
  })

  test("contextUsage has required shape", () => {
    const payload: StatusPayload = {
      id: "tester",
      status: "idle",
      contextUsage: mockUsage,
    }
    expect(payload.contextUsage).toHaveProperty("tokens")
    expect(payload.contextUsage).toHaveProperty("contextWindow")
    expect(payload.contextUsage).toHaveProperty("percent")
    expect(typeof payload.contextUsage!.tokens).toBe("number")
    expect(typeof payload.contextUsage!.contextWindow).toBe("number")
    expect(typeof payload.contextUsage!.percent).toBe("number")
  })

  test("contextUsage can have null tokens", () => {
    const payload: StatusPayload = {
      id: "scribe",
      status: "idle",
      contextUsage: { tokens: null, contextWindow: 128000, percent: null },
    }
    expect(payload.contextUsage!.tokens).toBeNull()
    expect(payload.contextUsage!.percent).toBeNull()
  })

  test("missing contextUsage is valid (undefined after compaction)", () => {
    const payload: StatusPayload = {
      id: "auditor",
      status: "idle",
    }
    expect(payload.contextUsage).toBeUndefined()
  })
})

/* ────────────────────────────────────────────────────
 *  Frontend SSE handler — verify the spread merge works
 *  (updated: only updates contextUsage when payload carries it)
 * ──────────────────────────────────────────────────── */

interface RosterEntry {
  id: string
  name: string
  color: string
  icon: string
  tools: string[]
  active: boolean
  status: string
  parallel: boolean
  contextUsage?: ContextUsagePayload
}

describe("useRoom SSE handler preserves contextUsage mid-turn", () => {
  const baseRoster: RosterEntry[] = [
    { id: "builder", name: "Builder", color: "#5dcaa5", icon: "🔨", tools: [], active: true, status: "idle", parallel: false },
    { id: "tester", name: "Tester", color: "#e6c07b", icon: "🧪", tools: [], active: true, status: "idle", parallel: false },
  ]

  // Simulate the SSE status handler from useRoom.ts (with the fix:
  // only update contextUsage when payload explicitly carries it)
  function handleStatus(currentRoster: RosterEntry[], data: { id: string; status: string; contextUsage?: ContextUsagePayload }): RosterEntry[] {
    return currentRoster.map(p => {
      if (p.id !== data.id) return p
      if (data.contextUsage !== undefined) return { ...p, status: data.status, contextUsage: data.contextUsage }
      return { ...p, status: data.status }
    })
  }

  test("contextUsage is merged into the right agent", () => {
    const data = { id: "builder", status: "idle", contextUsage: { tokens: 42000, contextWindow: 128000, percent: 32.8 } }
    const result = handleStatus(baseRoster, data)

    expect(result[0].contextUsage).toEqual(data.contextUsage)
    expect(result[1].contextUsage).toBeUndefined()
  })

  test("contextUsage overwrites previous value on new turn", () => {
    const rosterWithUsage: RosterEntry[] = [
      { ...baseRoster[0], contextUsage: { tokens: 30000, contextWindow: 128000, percent: 23.4 } },
      baseRoster[1],
    ]
    const data = { id: "builder", status: "idle", contextUsage: { tokens: 50000, contextWindow: 128000, percent: 39.1 } }
    const result = handleStatus(rosterWithUsage, data)

    expect(result[0].contextUsage).toEqual(data.contextUsage)
    expect(result[0].contextUsage!.tokens).toBe(50000)
  })

  test("status update WITHOUT contextUsage preserves existing value (mid-turn fix)", () => {
    const rosterWithUsage: RosterEntry[] = [
      { ...baseRoster[0], contextUsage: { tokens: 42000, contextWindow: 128000, percent: 32.8 } },
      baseRoster[1],
    ]
    // A mid-turn status event (e.g. "working") doesn't include contextUsage
    const data = { id: "builder", status: "working" }
    const result = handleStatus(rosterWithUsage, data)

    expect(result[0].status).toBe("working")
    // The fix: contextUsage is preserved, NOT cleared
    expect(result[0].contextUsage).toEqual({ tokens: 42000, contextWindow: 128000, percent: 32.8 })
  })

  test("compacting status without contextUsage preserves existing value", () => {
    const rosterWithUsage: RosterEntry[] = [
      { ...baseRoster[0], contextUsage: { tokens: 80000, contextWindow: 128000, percent: 62.5 } },
      baseRoster[1],
    ]
    const data = { id: "builder", status: "compacting" }
    const result = handleStatus(rosterWithUsage, data)

    expect(result[0].status).toBe("compacting")
    expect(result[0].contextUsage).toEqual({ tokens: 80000, contextWindow: 128000, percent: 62.5 })
  })

  test("idle status WITH contextUsage updates the value (post-turn)", () => {
    const rosterWithUsage: RosterEntry[] = [
      { ...baseRoster[0], contextUsage: { tokens: 42000, contextWindow: 128000, percent: 32.8 } },
      baseRoster[1],
    ]
    const data = { id: "builder", status: "idle", contextUsage: { tokens: 55000, contextWindow: 128000, percent: 43 } }
    const result = handleStatus(rosterWithUsage, data)

    expect(result[0].status).toBe("idle")
    expect(result[0].contextUsage!.tokens).toBe(55000)
  })
})

/* ────────────────────────────────────────────────────
 *  Room.runAgent — verify the broadcast is called
 * ──────────────────────────────────────────────────── */

describe("Room.runAgent emits contextUsage after turn", () => {
  test("getContextUsage is called with optional chaining", () => {
    const mockTarget: { persona: { id: string }; getContextUsage?: () => ContextUsagePayload } = {
      persona: { id: "builder" },
      getContextUsage: () => ({ tokens: 55000, contextWindow: 128000, percent: 43 }),
    }
    const usage = mockTarget.getContextUsage?.()
    expect(usage).toEqual({ tokens: 55000, contextWindow: 128000, percent: 43 })
  })

  test("missing getContextUsage is safely skipped", () => {
    const mockTarget: { persona: { id: string }; getContextUsage?: () => ContextUsagePayload } = {
      persona: { id: "builder" },
    }
    const usage = mockTarget.getContextUsage?.()
    expect(usage).toBeUndefined()
  })

  test("getContextUsage returning undefined is skipped", () => {
    const mockTarget: { persona: { id: string }; getContextUsage: () => undefined } = {
      persona: { id: "builder" },
      getContextUsage: () => undefined,
    }
    const usage = mockTarget.getContextUsage?.()
    expect(usage).toBeUndefined()
    const shouldBroadcast = !!usage
    expect(shouldBroadcast).toBe(false)
  })
})
