import { describe, it, expect } from "vitest"
import type { RosterItem } from "@pipeline-moe/client-core"
import { fmt, statsLine } from "../roster-stats"

// ── helpers ──────────────────────────────────────────────────────────────────

const baseStats = {
  tokens: { input: 29000, output: 4700, cacheRead: 35000, cacheWrite: 2000, total: 37000 },
  toolCalls: 26,
  userMessages: 5,
  assistantMessages: 5,
  totalMessages: 10,
  cost: 0.12,
}

const baseRoster = (partial: Partial<RosterItem> = {}): RosterItem => ({
  id: "a1",
  name: "Test",
  icon: "🔧",
  color: "cyan",
  active: true,
  status: "idle",
  parallel: false,
  model: "test/model",
  tools: [],
  ...partial,
})

// ── fmt ──────────────────────────────────────────────────────────────────────

describe("fmt", () => {
  it("formats large numbers as K with no decimals", () => {
    expect(fmt(42000)).toBe("42K")
    expect(fmt(100000)).toBe("100K")
    expect(fmt(200000)).toBe("200K")
  })

  it("formats mid-range numbers as K with 1 decimal", () => {
    expect(fmt(1200)).toBe("1.2K")
    expect(fmt(4700)).toBe("4.7K")
    expect(fmt(9900)).toBe("9.9K")
  })

  it("formats small numbers as-is", () => {
    expect(fmt(42)).toBe("42")
    expect(fmt(0)).toBe("0")
    expect(fmt(999)).toBe("999")
  })

  it("handles exactly 1000 — 1 decimal since < 10000", () => {
    expect(fmt(1000)).toBe("1.0K")
  })
})

// ── statsLine ────────────────────────────────────────────────────────────────

describe("statsLine", () => {
  it("returns null when no stats", () => {
    expect(statsLine(baseRoster())).toBeNull()
  })

  it("shows context usage with tokens", () => {
    const r = baseRoster({
      contextUsage: { tokens: 43000, contextWindow: 1000000, percent: 4.3 },
    })
    const line = statsLine(r)
    expect(line).toContain("43K")
    expect(line).toContain("1000K")
  })

  it("shows cache percentage from sessionStats", () => {
    const r = baseRoster({
      contextUsage: { tokens: 43000, contextWindow: 1000000, percent: 4.3 },
      sessionStats: baseStats,
    })
    const line = statsLine(r!)
    // cacheRead 35000 / total 37000 ≈ 95%
    expect(line).toContain("cache 95%")
  })

  it("shows — when tokens is null", () => {
    const r = baseRoster({
      contextUsage: { tokens: null, contextWindow: 128000, percent: null },
    })
    const line = statsLine(r)
    expect(line).toContain("—/128K")
  })

  it("combines context and cache with separator", () => {
    const r = baseRoster({
      contextUsage: { tokens: 43000, contextWindow: 1000000, percent: 4.3 },
      sessionStats: baseStats,
    })
    const line = statsLine(r!)
    expect(line).toContain("43K/1000K")
    expect(line).toContain(" ")
    expect(line).toContain("cache")
  })

  it("returns null when both contextUsage and sessionStats undefined", () => {
    const r = baseRoster()
    expect(statsLine(r)).toBeNull()
  })

  it("handles zero total (no division by zero)", () => {
    const r = baseRoster({
      contextUsage: { tokens: 0, contextWindow: 128000, percent: 0 },
      sessionStats: { ...baseStats, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    })
    const line = statsLine(r!)
    // cachePct should be null when total === 0, so no "cache" shown
    expect(line).not.toContain("cache")
    expect(line).toContain("0/128K")
  })
})
