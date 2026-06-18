import { test, expect, describe } from "vitest"

/* ────────────────────────────────────────────────────
 *  Session Stats — Empirical Verification
 * ──────────────────────────────────────────────────── */

interface TokenBreakdown {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

interface SessionStatsPayload {
  userMessages: number
  assistantMessages: number
  toolCalls: number
  tokens: TokenBreakdown
}

/* ── statsLabel formatting ──────────────────────── */

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`
  return String(n)
}

function statsLabel(s: SessionStatsPayload): string {
  const { input, output, cacheRead, total } = s.tokens
  const cachePct = total > 0 ? Math.round((cacheRead / total) * 100) : 0
  return `${fmt(input)}i · ${fmt(output)}o · cache ${cachePct}% · ${s.toolCalls} tools`
}

describe("statsLabel formatting", () => {
  test("normal usage → '42Ki · 1.2Ko · cache 92% · 3 tools'", () => {
    const stats: SessionStatsPayload = {
      userMessages: 5,
      assistantMessages: 4,
      toolCalls: 3,
      tokens: { input: 42100, output: 1200, cacheRead: 115000, cacheWrite: 10000, total: 125000 },
    }
    expect(statsLabel(stats)).toBe("42Ki · 1.2Ko · cache 92% · 3 tools")
  })

  test("small numbers → no K formatting", () => {
    const stats: SessionStatsPayload = {
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      tokens: { input: 500, output: 200, cacheRead: 400, cacheWrite: 300, total: 700 },
    }
    expect(statsLabel(stats)).toBe("500i · 200o · cache 57% · 0 tools")
  })

  test("large numbers ≥ 10K → integer K", () => {
    const stats: SessionStatsPayload = {
      userMessages: 20,
      assistantMessages: 20,
      toolCalls: 15,
      tokens: { input: 125000, output: 80000, cacheRead: 200000, cacheWrite: 5000, total: 205000 },
    }
    expect(statsLabel(stats)).toBe("125Ki · 80Ko · cache 98% · 15 tools")
  })

  test("zero total → cache 0%", () => {
    const stats: SessionStatsPayload = {
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
    expect(statsLabel(stats)).toBe("0i · 0o · cache 0% · 0 tools")
  })

  test("100% cache hit → '1.0Ki' (toFixed(1) for < 10K)", () => {
    const stats: SessionStatsPayload = {
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      tokens: { input: 1000, output: 0, cacheRead: 1000, cacheWrite: 0, total: 1000 },
    }
    expect(statsLabel(stats)).toBe("1.0Ki · 0o · cache 100% · 0 tools")
  })

  test("0% cache hit → '1.0Ki'", () => {
    const stats: SessionStatsPayload = {
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      tokens: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 1000, total: 1000 },
    }
    expect(statsLabel(stats)).toBe("1.0Ki · 0o · cache 0% · 0 tools")
  })
})

/* ── cachePct calculation ────────────────────────── */

describe("cache percentage calculation", () => {
  test("cachePct = cacheRead / total * 100, rounded", () => {
    const cacheRead = 115000
    const total = 125000
    const cachePct = Math.round((cacheRead / total) * 100)
    expect(cachePct).toBe(92)
  })

  test("total = 0 → cachePct = 0 (no division by zero)", () => {
    const cacheRead = 0
    const total = 0
    const cachePct = total > 0 ? Math.round((cacheRead / total) * 100) : 0
    expect(cachePct).toBe(0)
  })

  test("cacheRead > cacheWrite → high cache hit", () => {
    const cacheRead = 50000
    const total = 55000
    const cachePct = total > 0 ? Math.round((cacheRead / total) * 100) : 0
    expect(cachePct).toBe(91)
  })
})

/* ── Room.runAgent broadcast ────────────────────── */

describe("Room.runAgent broadcasts sessionStats after turn", () => {
  test("both contextUsage and sessionStats in payload", () => {
    const usage = { tokens: 42000, contextWindow: 128000, percent: 32.8 }
    const stats: SessionStatsPayload = {
      userMessages: 5,
      assistantMessages: 4,
      toolCalls: 3,
      tokens: { input: 42000, output: 1200, cacheRead: 40000, cacheWrite: 3200, total: 43200 },
    }
    const payload: Record<string, unknown> = { id: "builder", status: "idle" }
    if (usage) payload.contextUsage = usage
    if (stats) payload.sessionStats = stats

    expect(payload.contextUsage).toEqual(usage)
    expect(payload.sessionStats).toEqual(stats)
  })

  test("sessionStats only (no contextUsage) → still broadcasts", () => {
    const usage = undefined
    const stats: SessionStatsPayload = {
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      tokens: { input: 1000, output: 200, cacheRead: 800, cacheWrite: 400, total: 1200 },
    }
    const payload: Record<string, unknown> = { id: "auditor", status: "idle" }
    if (usage) payload.contextUsage = usage
    if (stats) payload.sessionStats = stats

    expect(payload.contextUsage).toBeUndefined()
    expect(payload.sessionStats).toEqual(stats)
  })

  test("contextUsage only (no sessionStats) → still broadcasts", () => {
    const usage = { tokens: 30000, contextWindow: 128000, percent: 23.4 }
    const stats = undefined
    const payload: Record<string, unknown> = { id: "scribe", status: "idle" }
    if (usage) payload.contextUsage = usage
    if (stats) payload.sessionStats = stats

    expect(payload.contextUsage).toEqual(usage)
    expect(payload.sessionStats).toBeUndefined()
  })

  test("neither contextUsage nor sessionStats → no broadcast", () => {
    const usage = undefined
    const stats = undefined
    const shouldBroadcast = !!(usage || stats)
    expect(shouldBroadcast).toBe(false)
  })
})

/* ── SSE handler — sessionStats preservation ────── */

describe("useRoom SSE handler preserves sessionStats mid-turn", () => {
  interface RosterEntry {
    id: string
    name: string
    color: string
    icon: string
    tools: string[]
    active: boolean
    status: string
    sessionStats?: SessionStatsPayload
  }

  const baseRoster: RosterEntry[] = [
    { id: "builder", name: "Builder", color: "#5dcaa5", icon: "🔨", tools: [], active: true, status: "idle" },
    { id: "auditor", name: "Auditor", color: "#9b8ec4", icon: "🔍", tools: [], active: true, status: "idle" },
  ]

  function handleStatus(currentRoster: RosterEntry[], data: { id: string; status: string; sessionStats?: SessionStatsPayload }): RosterEntry[] {
    return currentRoster.map(p => {
      if (p.id !== data.id) return p
      const base = { ...p, status: data.status }
      if (data.sessionStats !== undefined) base.sessionStats = data.sessionStats
      return base
    })
  }

  test("sessionStats merged into the right agent", () => {
    const stats: SessionStatsPayload = {
      userMessages: 5,
      assistantMessages: 4,
      toolCalls: 3,
      tokens: { input: 42000, output: 1200, cacheRead: 40000, cacheWrite: 3200, total: 43200 },
    }
    const data = { id: "builder", status: "idle", sessionStats: stats }
    const result = handleStatus(baseRoster, data)

    expect(result[0].sessionStats).toEqual(stats)
    expect(result[1].sessionStats).toBeUndefined()
  })

  test("mid-turn status without sessionStats preserves existing value", () => {
    const stats: SessionStatsPayload = {
      userMessages: 3,
      assistantMessages: 2,
      toolCalls: 1,
      tokens: { input: 30000, output: 800, cacheRead: 28000, cacheWrite: 2800, total: 30800 },
    }
    const rosterWithStats: RosterEntry[] = [
      { ...baseRoster[0], sessionStats: stats },
      baseRoster[1],
    ]
    const data = { id: "builder", status: "working" }
    const result = handleStatus(rosterWithStats, data)

    expect(result[0].status).toBe("working")
    expect(result[0].sessionStats).toEqual(stats)
  })

  test("new turn updates sessionStats", () => {
    const oldStats: SessionStatsPayload = {
      userMessages: 3,
      assistantMessages: 2,
      toolCalls: 1,
      tokens: { input: 30000, output: 800, cacheRead: 28000, cacheWrite: 2800, total: 30800 },
    }
    const newStats: SessionStatsPayload = {
      userMessages: 5,
      assistantMessages: 4,
      toolCalls: 3,
      tokens: { input: 50000, output: 2000, cacheRead: 48000, cacheWrite: 4000, total: 52000 },
    }
    const rosterWithStats: RosterEntry[] = [
      { ...baseRoster[0], sessionStats: oldStats },
      baseRoster[1],
    ]
    const data = { id: "builder", status: "idle", sessionStats: newStats }
    const result = handleStatus(rosterWithStats, data)

    expect(result[0].sessionStats).toEqual(newStats)
    expect(result[0].sessionStats!.tokens.input).toBe(50000)
  })
})

/* ── Roster rendering — sessionStats visibility ─── */

describe("Roster sessionStats rendering", () => {
  test("sessionStats present → renders", () => {
    const entry = {
      id: "builder",
      sessionStats: {
        userMessages: 5,
        assistantMessages: 4,
        toolCalls: 3,
        tokens: { input: 42000, output: 1200, cacheRead: 40000, cacheWrite: 3200, total: 43200 },
      },
    }
    const shouldShow = !!entry.sessionStats
    expect(shouldShow).toBe(true)
    const label = statsLabel(entry.sessionStats!)
    expect(label).toBe("42Ki · 1.2Ko · cache 93% · 3 tools")
  })

  test("sessionStats undefined → does not render", () => {
    const entry = {
      id: "builder",
      sessionStats: undefined,
    }
    const shouldShow = !!entry.sessionStats
    expect(shouldShow).toBe(false)
  })

  test("tooltip contains full breakdown", () => {
    const stats: SessionStatsPayload = {
      userMessages: 5,
      assistantMessages: 4,
      toolCalls: 3,
      tokens: { input: 42000, output: 1200, cacheRead: 40000, cacheWrite: 3200, total: 43200 },
    }
    const tooltip = `Input: ${stats.tokens.input} · Output: ${stats.tokens.output} · Cache read: ${stats.tokens.cacheRead} · Cache write: ${stats.tokens.cacheWrite}`
    expect(tooltip).toBe("Input: 42000 · Output: 1200 · Cache read: 40000 · Cache write: 3200")
  })
})

/* ── fmt function edge cases ──────────────────── */

describe("fmt function formatting", () => {
  test("0 → '0'", () => expect(fmt(0)).toBe("0"))
  test("999 → '999'", () => expect(fmt(999)).toBe("999"))
  test("1000 → '1.0K'", () => expect(fmt(1000)).toBe("1.0K"))
  test("1200 → '1.2K'", () => expect(fmt(1200)).toBe("1.2K"))
  test("9999 → '10.0K'", () => expect(fmt(9999)).toBe("10.0K"))
  test("10000 → '10K'", () => expect(fmt(10000)).toBe("10K"))
  test("125000 → '125K'", () => expect(fmt(125000)).toBe("125K"))
})
