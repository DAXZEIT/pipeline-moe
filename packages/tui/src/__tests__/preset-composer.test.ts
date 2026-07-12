import { describe, expect, it } from "vitest"
import type { PresetPersona } from "@pipeline-moe/client-core"
import {
  backspaceText,
  blankMember,
  clonePersonas,
  cycle,
  duplicateMember,
  memberFromTemplate,
  moveMember,
  slugify,
  teamStats,
  THINKING_CYCLE,
  TOOL_GROUPS,
  toPresetFile,
  uniqueId,
  VISION_CYCLE,
  visionLabel,
} from "../preset-composer"

const member = (over: Partial<PresetPersona> = {}): PresetPersona => ({
  id: "scout",
  name: "Scout",
  color: "#5DCAA5",
  icon: "🔍",
  tools: ["read", "grep"],
  active: true,
  ...over,
})

describe("backspaceText", () => {
  it("removes whole code points, never leaving a lone surrogate", () => {
    expect(backspaceText("ab")).toBe("a")
    expect(backspaceText("a🤖")).toBe("a")
    expect(backspaceText("🤖")).toBe("")
    expect(backspaceText("")).toBe("")
  })
})

describe("ids", () => {
  it("slugify mirrors the server slug", () => {
    expect(slugify("Le Scout Rapide")).toBe("le-scout-rapide")
    expect(slugify("  ---  ")).toBe("")
  })

  it("uniqueId suffixes past taken ids", () => {
    expect(uniqueId("scout", new Set())).toBe("scout")
    expect(uniqueId("scout", new Set(["scout", "scout-2"]))).toBe("scout-3")
  })
})

describe("roster operations", () => {
  it("blankMember rotates palette colors and never collides on id", () => {
    const first = blankMember([])
    expect(first.id).toBe("agent")
    const second = blankMember([first])
    expect(second.id).toBe("agent-2")
    expect(second.color).not.toBe(first.color)
    expect(second.tools).toEqual(["read", "grep", "find", "ls"])
  })

  it("duplicateMember inserts a deep copy right after the source", () => {
    const list = [member(), member({ id: "auditor", name: "Auditor" })]
    const out = duplicateMember(list, 0)
    expect(out.map((p) => p.id)).toEqual(["scout", "scout-2", "auditor"])
    out[1].tools.push("bash")
    expect(out[0].tools).toEqual(["read", "grep"])
  })

  it("moveMember clamps at the edges and reports the new index", () => {
    const list = [member({ id: "a" }), member({ id: "b" }), member({ id: "c" })]
    expect(moveMember(list, 0, -1).index).toBe(0)
    const down = moveMember(list, 0, +1)
    expect(down.list.map((p) => p.id)).toEqual(["b", "a", "c"])
    expect(down.index).toBe(1)
  })

  it("clonePersonas detaches tools and skills from the source", () => {
    const src = [member({ skills: ["webfetch"] })]
    const copy = clonePersonas(src)
    copy[0].tools.push("bash")
    copy[0].skills!.push("x")
    expect(src[0].tools).toEqual(["read", "grep"])
    expect(src[0].skills).toEqual(["webfetch"])
  })
})

describe("memberFromTemplate", () => {
  it("seeds from the template, deduping the id against the roster", () => {
    const t = { id: "builder", name: "Builder", color: "#EF9F27", icon: "🔨", tools: ["read", "edit"], model: "anthropic/claude-haiku-4-5" }
    const first = memberFromTemplate(t, [])
    expect(first).toMatchObject({ id: "builder", model: "anthropic/claude-haiku-4-5", active: true })
    const second = memberFromTemplate(t, [first])
    expect(second.id).toBe("builder-2")
    second.tools.push("bash")
    expect(t.tools).toEqual(["read", "edit"])
  })

  it("omits model when the template has none", () => {
    const p = memberFromTemplate({ id: "x", name: "X", color: "#888888", icon: "🤖", tools: [] }, [])
    expect("model" in p).toBe(false)
  })
})

describe("teamStats", () => {
  it("counts members, parallel lanes, and inactive", () => {
    const s = teamStats([
      member({ parallel: true }),
      member({ id: "b", parallel: true }),
      member({ id: "c", active: false }),
    ])
    expect(s).toBe("3 members · 2 parallel · 1 inactive · ⚠ nobody can write")
  })

  it("flags the writer hole before the web hole", () => {
    expect(teamStats([member()])).toContain("nobody can write")
    expect(teamStats([member({ tools: ["write"] })])).toContain("no web access")
    expect(teamStats([member({ tools: ["write", "web_read"] })])).toBe("1 member")
  })

  it("ignores inactive members for coverage (they don't play)", () => {
    const s = teamStats([member({ tools: ["write", "web_read"], active: false }), member({ id: "b" })])
    expect(s).toContain("nobody can write")
  })

  it("names fused seats and warns on a model mix (defuses at room load)", () => {
    const clean = teamStats([
      member({ id: "builder", tools: ["write"], seat: "maker", model: "local/q.gguf" }),
      member({ id: "tester", tools: ["read", "web_read"], seat: "maker", model: "local/q.gguf" }),
    ])
    expect(clean).toContain("⌐maker: builder+tester")
    expect(clean).not.toContain("mixes models")
    const mixed = teamStats([
      member({ id: "builder", tools: ["write", "web_read"], seat: "maker", model: "local/q.gguf" }),
      member({ id: "tester", seat: "maker" }),
    ])
    expect(mixed).toContain("⚠ seat maker mixes models")
  })

  it("a singleton seat declaration renders no cluster line", () => {
    expect(teamStats([member({ tools: ["write", "web_read"], seat: "maker" })])).toBe("1 member")
  })
})

describe("cycles", () => {
  it("cycle wraps both ways and recovers from unknown values", () => {
    expect(cycle(THINKING_CYCLE, undefined, +1)).toBe("off")
    expect(cycle(THINKING_CYCLE, undefined, -1)).toBe("xhigh")
    expect(cycle(THINKING_CYCLE, "weird", +1)).toBe("off")
    expect(cycle(VISION_CYCLE, true, +1)).toBe(false)
    expect(cycle(VISION_CYCLE, false, +1)).toBeUndefined()
  })

  it("visionLabel names the tri-state", () => {
    expect(visionLabel(undefined)).toBe("default (on)")
    expect(visionLabel(true)).toBe("on")
    expect(visionLabel(false)).toBe("off")
  })
})

describe("toPresetFile", () => {
  it("carries gates through a remix untouched, drops them when absent", () => {
    const gates = [{ from: "scout", via: "auditor" }]
    const out = toPresetFile("t", [member()], { name: "src", personas: [], handoffGates: gates })
    expect(out.handoffGates).toEqual(gates)
    expect("handoffGates" in toPresetFile("t", [member()])).toBe(false)
  })
})

describe("TOOL_GROUPS", () => {
  it("covers the full grantable tool surface with no duplicates", () => {
    const all = TOOL_GROUPS.flatMap((g) => g.tools)
    expect(new Set(all).size).toBe(all.length)
    expect(all.length).toBe(17)
  })
})
