import { describe, expect, it } from "vitest"
import type { RosterItem } from "@pipeline-moe/client-core"
import { stripCells, STATUS_GLYPH } from "../roster-strip"

const agent = (over: Partial<RosterItem>): RosterItem =>
  ({
    id: "planner",
    name: "planner",
    icon: "🦉",
    color: "cyan",
    active: true,
    status: "idle",
    parallel: false,
    model: "local/qwopus",
    ...over,
  }) as RosterItem

describe("stripCells", () => {
  it("name tier when wide: glyph + icon + name per cell", () => {
    const cells = stripCells([agent({}), agent({ id: "builder", name: "builder", icon: "🔨", status: "working" })], null, 120)
    expect(cells[0].text).toBe("○ 🦉 planner")
    expect(cells[1].text).toBe(`${STATUS_GLYPH.working} 🔨 builder`)
  })

  it("drops to icon tier when the named cells overflow the width", () => {
    const many = Array.from({ length: 8 }, (_, i) => agent({ id: `a${i}`, name: `agent-number-${i}` }))
    const cells = stripCells(many, null, 60)
    expect(cells[0].text).toBe("○ 🦉")
  })

  it("flags the running agent and keeps its color", () => {
    const cells = stripCells([agent({}), agent({ id: "builder", color: "yellow" })], "builder", 120)
    expect(cells[0].running).toBe(false)
    expect(cells[1].running).toBe(true)
    expect(cells[1].color).toBe("yellow")
  })

  it("paused agents go gray + dim", () => {
    const cells = stripCells([agent({ active: false })], null, 120)
    expect(cells[0].color).toBe("gray")
    expect(cells[0].dim).toBe(true)
  })

  it("hot context (≥80%) appends the percent and sets warn", () => {
    const hot = agent({ contextUsage: { tokens: 160_000, contextWindow: 200_000, percent: 84 } as RosterItem["contextUsage"] })
    const cells = stripCells([hot], null, 120)
    expect(cells[0].text).toContain("84%")
    expect(cells[0].warn).toBe(true)
    const cold = stripCells([agent({ contextUsage: { tokens: 10, contextWindow: 200_000, percent: 12 } as RosterItem["contextUsage"] })], null, 120)
    expect(cold[0].text).not.toContain("%")
    expect(cold[0].warn).toBe(false)
  })

  it("marks vision-off agents", () => {
    const cells = stripCells([agent({ vision: false })], null, 120)
    expect(cells[0].text).toContain("🚫")
  })
})
