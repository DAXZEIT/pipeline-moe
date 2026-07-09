import { describe, expect, it } from "vitest"
import stringWidth from "string-width"
import type { RosterItem } from "@pipeline-moe/client-core"
import { renderStrip, stripCells, stripRowCount, STATUS_GLYPH } from "../roster-strip"

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

  it("model row: pretty name under pinned agents, 'default' under the rest", () => {
    const cells = stripCells(
      [agent({ model: "anthropic/claude-opus-4-8" }), agent({ id: "builder", name: "builder", model: undefined })],
      null,
      120,
    )
    expect(cells[0].sub).toBe("Opus 4.8")
    expect(cells[1].sub).toBe("default")
  })

  it("no model row when no agent pins a model, nor at icon tier", () => {
    const cells = stripCells([agent({ model: undefined })], null, 120)
    expect(cells[0].sub).toBeUndefined()
    const many = Array.from({ length: 8 }, (_, i) => agent({ id: `a${i}`, name: `agent-number-${i}` }))
    for (const c of stripCells(many, null, 60)) expect(c.sub).toBeUndefined()
  })
})

describe("stripRowCount", () => {
  it("0 empty, 1 without models, 2 with a pinned model at name tier", () => {
    expect(stripRowCount([], 120)).toBe(0)
    expect(stripRowCount([agent({ model: undefined })], 120)).toBe(1)
    expect(stripRowCount([agent({})], 120)).toBe(2)
    // icon tier drops the model row again
    const many = Array.from({ length: 8 }, (_, i) => agent({ id: `a${i}`, name: `agent-number-${i}` }))
    expect(stripRowCount(many, 60)).toBe(1)
  })
})

describe("renderStrip", () => {
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")

  it("model row gutters line up with the top row's", () => {
    const cells = stripCells(
      [agent({ model: "anthropic/claude-opus-4-8" }), agent({ id: "builder", name: "builder", icon: "🔨" })],
      "builder",
      120,
    )
    const [top, sub] = renderStrip(cells).map(plain)
    expect(sub).toBeDefined()
    expect(top.indexOf(" │ ")).toBe(sub.indexOf(" │ "))
    expect(stringWidth(top)).toBe(stringWidth(sub))
  })

  it("a long model name truncates to its cell instead of widening it", () => {
    const cells = stripCells([agent({ model: "local/Qwopus3.6-27B-v2-MTP-Q4_K_M.gguf" })], null, 120)
    const [top, sub] = renderStrip(cells).map(plain)
    expect(stringWidth(sub)).toBe(stringWidth(top))
    expect(sub).toContain("…")
  })
})
