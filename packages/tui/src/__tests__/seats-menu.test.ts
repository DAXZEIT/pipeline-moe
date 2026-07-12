import { describe, expect, it } from "vitest"
import type { RosterItem } from "@pipeline-moe/client-core"
import { seatActionItems, seatPickerItems } from "../seats-menu"

const agent = (over: Partial<RosterItem>): RosterItem =>
  ({
    id: "planner",
    name: "Planner",
    icon: "📋",
    color: "cyan",
    active: true,
    status: "idle",
    parallel: false,
    ...over,
  }) as RosterItem

const roster = [
  agent({ id: "builder", name: "Builder", icon: "🔨", seat: "maker", model: "local/q.gguf" }),
  agent({ id: "tester", name: "Tester", icon: "🧪", seat: "maker", model: "local/q.gguf" }),
  agent({}),
  agent({ id: "scribe", name: "Scribe", icon: "📝" }),
]

describe("seatPickerItems", () => {
  it("groups fused hats first with the ⌐seat prefix, then own-context members", () => {
    const items = seatPickerItems(roster)
    expect(items.map((i) => i.id)).toEqual(["builder", "tester", "planner", "scribe"])
    expect(items[0].label).toBe("⌐maker · 🔨 Builder")
    expect(items[0].hint).toContain("shares context with @tester")
    expect(items[2].label).toBe("📋 Planner")
    expect(items[2].hint).toContain("own context")
  })
})

describe("seatActionItems", () => {
  it("a singleton can join the fused seat or pair with the other singleton", () => {
    const planner = roster[2]
    const items = seatActionItems(planner, roster)
    expect(items.map((i) => i.id)).toEqual(["join:maker", "pair:scribe"])
    expect(items[0].label).toBe("⇥ Join ⌐maker")
    expect(items[0].hint).toContain("@builder + @tester")
    expect(items[1].label).toContain("Share a seat with 📝 Scribe")
  })

  it("a fused hat gets the detach action; its own seat is not a join target", () => {
    const tester = roster[1]
    const ids = seatActionItems(tester, roster).map((i) => i.id)
    expect(ids).toContain("solo")
    expect(ids).not.toContain("join:maker")
  })

  it("flags declared-model mismatches in the hint (the server will refuse)", () => {
    const planner = agent({ model: "anthropic/claude-fable-5" })
    const items = seatActionItems(planner, roster)
    expect(items.find((i) => i.id === "join:maker")?.hint).toContain("different model")
    // scribe is on the host default like nobody else — planner pins a model → mismatch
    expect(items.find((i) => i.id === "pair:scribe")?.hint).toContain("different model")
  })

  it("no mismatch flag when declared models agree (both undefined = host default)", () => {
    const planner = roster[2] // undefined model
    const items = seatActionItems(planner, roster)
    expect(items.find((i) => i.id === "pair:scribe")?.hint).not.toContain("different model")
  })

  it("empty when alone in the room (nobody to share with)", () => {
    const solo = agent({})
    expect(seatActionItems(solo, [solo])).toEqual([])
  })
})
