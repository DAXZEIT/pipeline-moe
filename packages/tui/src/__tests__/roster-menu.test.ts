import { describe, expect, test } from "vitest"
import type { RosterItem } from "@pipeline-moe/client-core"
import { agentActionItems, rosterPickerItems } from "../roster-menu"

// The Ctrl+R roster menu's pure builders: what tests pin down is the
// CONTEXTUAL composition — which actions appear for which live state, and
// that toggle labels read as state, not blind verbs.

const agent = (over: Partial<RosterItem> = {}): RosterItem => ({
  id: "builder",
  name: "Builder",
  color: "#f80",
  icon: "🔨",
  tools: [],
  active: true,
  status: "idle",
  parallel: false,
  ...over,
})

describe("rosterPickerItems", () => {
  test("one row per agent with live hints; the default agent is starred", () => {
    const items = rosterPickerItems(
      [
        agent({ contextUsage: { tokens: 14200, contextWindow: 200000, percent: 7 } }),
        agent({ id: "scout", name: "Scout", icon: "🔍", active: false, model: "local/Qwopus3.6-27B-v2-MTP-Q4_K_M.gguf" }),
      ],
      "builder",
    )
    expect(items[0].label).toBe("🔨 Builder ⭐")
    expect(items[0].hint).toContain("14K")
    expect(items[1].label).toBe("🔍 Scout")
    expect(items[1].hint).toContain("inactive")
    expect(items[1].hint).toContain("Qwopus")
  })
})

describe("agentActionItems", () => {
  test("toggle labels carry the live state", () => {
    const items = agentActionItems(agent({ parallel: true, vision: false }), true)
    const byId = Object.fromEntries(items.map((i) => [i.id, i.label]))
    expect(byId.default).toContain("on")
    expect(byId.parallel).toContain("⫽  Parallel: on")
    expect(byId.vision).toContain("Vision: off")
    expect(byId.active).toContain("Deactivate")
  })

  test("an inactive agent offers Activate; a non-default agent shows default: off", () => {
    const items = agentActionItems(agent({ active: false }), false)
    const byId = Object.fromEntries(items.map((i) => [i.id, i.label]))
    expect(byId.active).toContain("Activate")
    expect(byId.default).toContain("off")
  })

  test("steer appears only mid-turn", () => {
    expect(agentActionItems(agent({ status: "idle" }), false).some((i) => i.id === "steer")).toBe(false)
    expect(agentActionItems(agent({ status: "working" }), false).some((i) => i.id === "steer")).toBe(true)
    expect(agentActionItems(agent({ status: "thinking" }), false).some((i) => i.id === "steer")).toBe(true)
  })

  test("kick is present and last — the destructive action anchors the bottom", () => {
    const items = agentActionItems(agent(), false)
    expect(items.at(-1)!.id).toBe("kick")
    expect(items.at(-1)!.hint).toBe("confirm")
  })
})
