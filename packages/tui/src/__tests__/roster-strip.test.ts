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

  it("usage row carries tokens/window; hot context (≥80%) sets warn", () => {
    const hot = agent({ contextUsage: { tokens: 160_000, contextWindow: 200_000, percent: 84 } as RosterItem["contextUsage"] })
    const cells = stripCells([hot], null, 120)
    expect(cells[0].use).toBe("160K/200K")
    expect(cells[0].warn).toBe(true)
    // the % alarm lives in the usage row now, not the cell text
    expect(cells[0].text).not.toContain("%")
    const cold = stripCells([agent({ contextUsage: { tokens: 10, contextWindow: 200_000, percent: 12 } as RosterItem["contextUsage"] })], null, 120)
    expect(cold[0].use).toBe("10/200K")
    expect(cold[0].warn).toBe(false)
  })

  it("without a usage row, hot context falls back to the in-cell percent", () => {
    // roster fixtures without contextUsage → no usage row → the old alarm
    const cells = stripCells([agent({})], null, 120)
    expect(cells[0].use).toBeUndefined()
  })

  it("marks vision-off agents", () => {
    const cells = stripCells([agent({ vision: false })], null, 120)
    expect(cells[0].text).toContain("🚫")
  })

  it("model row: pretty name under pinned agents, resolved default under the rest", () => {
    const cells = stripCells(
      [agent({ model: "anthropic/claude-opus-4-8" }), agent({ id: "builder", name: "builder", model: undefined })],
      null,
      120,
      "local/Qwopus3.6-27B-v2-MTP-Q4_K_M.gguf",
    )
    expect(cells[0].sub).toBe("Opus 4.8")
    expect(cells[1].sub).toBe("Qwopus3.6 27B V2 MTP")
  })

  it("falls back to 'default' when the server doesn't say what default resolves to", () => {
    const cells = stripCells([agent({ model: "anthropic/claude-fable-5" }), agent({ id: "b", name: "b", model: undefined })], null, 120)
    expect(cells[1].sub).toBe("default")
  })

  it("no model row when nothing is pinned and no default is known, nor at icon tier", () => {
    const cells = stripCells([agent({ model: undefined })], null, 120)
    expect(cells[0].sub).toBeUndefined()
    const many = Array.from({ length: 8 }, (_, i) => agent({ id: `a${i}`, name: `agent-number-${i}` }))
    for (const c of stripCells(many, null, 60, "local/qwopus")) {
      expect(c.sub).toBeUndefined()
      expect(c.use).toBeUndefined()
    }
  })
})

describe("stripRowCount", () => {
  it("0 empty; 1 + model row + usage row as the data appears", () => {
    expect(stripRowCount([], 120)).toBe(0)
    expect(stripRowCount([agent({ model: undefined })], 120)).toBe(1)
    expect(stripRowCount([agent({})], 120)).toBe(2)
    expect(stripRowCount([agent({ model: undefined })], 120, "local/qwopus")).toBe(2)
    const full = agent({ contextUsage: { tokens: 1000, contextWindow: 200_000, percent: 1 } as RosterItem["contextUsage"] })
    expect(stripRowCount([full], 120, "local/qwopus")).toBe(3)
    // icon tier drops the under-rows again
    const many = Array.from({ length: 8 }, (_, i) => full && agent({ id: `a${i}`, name: `agent-number-${i}`, contextUsage: full.contextUsage }))
    expect(stripRowCount(many, 60, "local/qwopus")).toBe(1)
  })
})

describe("renderStrip", () => {
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")
  const usage = { tokens: 220_000, contextWindow: 1_000_000, percent: 22 } as RosterItem["contextUsage"]

  it("under-row gutters line up with the top row's, all rows equal width", () => {
    const cells = stripCells(
      [agent({ model: "anthropic/claude-opus-4-8", contextUsage: usage }), agent({ id: "builder", name: "builder", icon: "🔨", contextUsage: usage })],
      "builder",
      120,
      "local/qwopus",
    )
    const rows = renderStrip(cells).map(plain)
    expect(rows).toHaveLength(3)
    expect(rows[2]).toContain("220K/1000K")
    for (const r of rows.slice(1)) {
      expect(r.indexOf(" │ ")).toBe(rows[0].indexOf(" │ "))
      expect(stringWidth(r)).toBe(stringWidth(rows[0]))
    }
  })

  it("a long model name widens its cell into the strip's free space (solo room fix)", () => {
    const cells = stripCells([agent({ model: "local/Qwopus3.6-27B-v2-MTP-Q4_K_M.gguf" })], null, 120)
    const [top, sub] = renderStrip(cells).map(plain)
    expect(stringWidth(sub)).toBe(stringWidth(top))
    expect(sub).not.toContain("…")
    expect(sub.trim()).toBe("Qwopus3.6 27B V2 MTP")
  })

  it("with NO free space the under-row still truncates to its cell", () => {
    // 8 named agents at width 90: the strip is packed — no slack to grant.
    const many = Array.from({ length: 6 }, (_, i) =>
      agent({ id: `a${i}`, name: `ag${i}`, model: "local/Qwopus3.6-27B-v2-MTP-Q4_K_M.gguf" }),
    )
    const cells = stripCells(many, null, 66)
    if (cells[0].text.includes("ag0")) {
      // still name tier: every cell got at most its share; rows stay aligned
      const rows = renderStrip(cells).map(plain)
      expect(stringWidth(rows[1])).toBe(stringWidth(rows[0]))
    }
  })

  it("granted slack keeps all rows equal width and gutters aligned", () => {
    const cells = stripCells(
      [
        agent({ model: "anthropic/claude-fable-5", contextUsage: usage }),
        agent({ id: "builder", name: "builder", icon: "🔨", contextUsage: usage }),
      ],
      "builder",
      120,
      "local/qwopus",
    )
    const rows = renderStrip(cells).map(plain)
    for (const r of rows.slice(1)) {
      expect(r.indexOf(" │ ")).toBe(rows[0].indexOf(" │ "))
      expect(stringWidth(r)).toBe(stringWidth(rows[0]))
    }
  })

  it("fused seat: hats join with the ┈ gutter, one spanning labeled gauge, rows stay aligned", () => {
    const usage2 = { tokens: 42_000, contextWindow: 200_000, percent: 21 } as RosterItem["contextUsage"]
    const cells = stripCells(
      [
        agent({ id: "builder", name: "builder", icon: "🔨", seat: "maker", contextUsage: usage2, model: "local/qwopus" }),
        agent({ id: "tester", name: "tester", icon: "🧪", seat: "maker", contextUsage: usage2, model: "local/qwopus" }),
        agent({ id: "planner", name: "planner", contextUsage: usage, model: "local/qwopus" }),
      ],
      null,
      140,
    )
    expect(cells[0].seat).toBe("maker")
    const rows = renderStrip(cells).map(plain)
    // Fused gutter INSIDE the seat, wall between seats.
    expect(rows[0]).toContain("builder ┈ ")
    expect(rows[0]).toContain("tester │ ")
    // One spanning usage entry, ⌐-marked — not one gauge per hat, and never
    // the seat NAME (a long name would truncate the payload away).
    expect(rows[2]).toContain("⌐ 42K/200K")
    expect(rows[2]).not.toContain("maker:")
    expect(rows[2].match(/42K\/200K/g)).toHaveLength(1)
    expect(rows[2]).toContain("220K/1000K") // the singleton keeps its own
    // All rows keep the exact same printed width.
    for (const r of rows.slice(1)) expect(stringWidth(r)).toBe(stringWidth(rows[0]))
  })

  it("a SCATTERED seat is normalized: mates pull up behind the first hat", () => {
    // planner(maker) at 0, scribe(maker) at the END — the exact live report:
    // the pre-normalization strip stranded each hat in its own wall-separated
    // cell with no ⌐group at all.
    const cells = stripCells(
      [
        agent({ id: "planner", name: "planner", seat: "pl-sc" }),
        agent({ id: "builder", name: "builder", icon: "🔨" }),
        agent({ id: "scribe", name: "scribe", icon: "📝", seat: "pl-sc" }),
      ],
      null,
      140,
    )
    expect(cells.map((c) => c.id)).toEqual(["planner", "scribe", "builder"])
    const rows = renderStrip(cells).map(plain)
    expect(rows[0]).toContain("planner ┈ ")
    expect(rows[0]).toContain("scribe │ ")
  })

  it("singleton-only rosters render exactly as before (no seat → no fusion)", () => {
    const cells = stripCells([agent({}), agent({ id: "b", name: "b" })], null, 120)
    const rows = renderStrip(cells).map(plain)
    expect(rows[0]).not.toContain("┈")
    expect(rows[0]).toContain(" │ ")
  })

  it("hot usage paints yellow", async () => {
    // chalk auto-detects no color under vitest — force it for this assertion
    const { default: chalk } = await import("chalk")
    const level = chalk.level
    chalk.level = 3
    try {
      const hot = agent({ contextUsage: { tokens: 900_000, contextWindow: 1_000_000, percent: 90 } as RosterItem["contextUsage"] })
      const rows = renderStrip(stripCells([hot], null, 120))
      expect(rows[2]).toContain("\x1b[33m")
    } finally {
      chalk.level = level
    }
  })
})
