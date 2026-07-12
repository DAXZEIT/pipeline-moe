// Unit tests for the pure seat layer (src/seats.ts) — fused seats phase 1.

import { describe, expect, it } from "vitest"
import {
  buildHatHeader,
  buildSeatSystemPrompt,
  clusterBySeat,
  commonPromptPrefix,
  hatSwitchSuffix,
  hatToolGate,
  seatCompactionInstructions,
  seatIdOf,
  unionTools,
  validateSeatModels,
} from "../seats.js"

const builder = {
  id: "builder",
  name: "Builder",
  seat: "maker",
  tools: ["read", "edit", "write", "bash"],
  systemPrompt: "SHARED BASE\nline two\nBuilder duties: implement.",
  compactionInstructions: "Preserve code changes. Discard failed attempts.",
}
const tester = {
  id: "tester",
  name: "Tester",
  seat: "maker",
  tools: ["read", "bash", "grep"],
  systemPrompt: "SHARED BASE\nline two\nTester duties: verify.",
  compactionInstructions: "Preserve test results. Discard superseded runs.",
}
const auditor = {
  id: "auditor",
  name: "Auditor",
  tools: ["read", "grep"],
  systemPrompt: "SHARED BASE\nline two\nAuditor duties: audit.",
}

describe("seatIdOf", () => {
  it("defaults to the persona id — pre-feature behavior", () => {
    expect(seatIdOf({ id: "builder" })).toBe("builder")
    expect(seatIdOf({ id: "builder", seat: "" })).toBe("builder")
    expect(seatIdOf({ id: "builder", seat: "   " })).toBe("builder")
  })
  it("resolves to the declared seat", () => {
    expect(seatIdOf({ id: "builder", seat: "maker" })).toBe("maker")
  })
})

describe("clusterBySeat", () => {
  it("groups by resolved seat, insertion-ordered", () => {
    const clusters = clusterBySeat([builder, tester, auditor])
    expect([...clusters.keys()]).toEqual(["maker", "auditor"])
    expect(clusters.get("maker")!.map((p) => p.id)).toEqual(["builder", "tester"])
    expect(clusters.get("auditor")!.map((p) => p.id)).toEqual(["auditor"])
  })
})

describe("validateSeatModels", () => {
  it("accepts a seat whose hats share a modelRef (including the process default)", () => {
    const { warnings, defused } = validateSeatModels([builder, tester], () => undefined)
    expect(warnings).toEqual([])
    expect(defused.size).toBe(0)
  })
  it("defuses the whole seat on mixed modelRefs, loudly", () => {
    const refOf = (p: { id: string }) => (p.id === "builder" ? "local/qwopus-27b" : "anthropic/claude-opus")
    const { warnings, defused } = validateSeatModels([builder, tester], refOf)
    expect(defused.has("maker")).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('seat "maker" mixes models')
    expect(warnings[0]).toContain("builder")
    expect(warnings[0]).toContain("tester")
  })
  it("never flags singleton seats", () => {
    const { warnings, defused } = validateSeatModels([auditor], () => "local/x")
    expect(warnings).toEqual([])
    expect(defused.size).toBe(0)
  })
})

describe("unionTools", () => {
  it("unions in first-seen order without duplicates", () => {
    expect(unionTools([builder, tester])).toEqual(["read", "edit", "write", "bash", "grep"])
  })
})

describe("hatToolGate", () => {
  const gate = hatToolGate([builder, tester], () => "tester")
  it("allows the current hat's own tools", () => {
    expect(gate("read")).toBeNull()
    expect(gate("bash")).toBeNull()
  })
  it("refuses another hat's tool, naming the owner and the way out", () => {
    const msg = gate("edit")
    expect(msg).toContain("builder hat")
    expect(msg).toContain("tester hat")
    expect(msg).toContain("hand off")
  })
  it("never gates context-granted primitives absent from every allowlist", () => {
    expect(gate("handoff")).toBeNull()
    expect(gate("task_create")).toBeNull()
  })
  it("re-reads the current hat at every call — the gate is dynamic", () => {
    let hat = "tester"
    const g = hatToolGate([builder, tester], () => hat)
    expect(g("edit")).not.toBeNull()
    hat = "builder"
    expect(g("edit")).toBeNull()
  })
})

describe("seatCompactionInstructions", () => {
  it("keeps a singleton's instructions verbatim — byte-compat", () => {
    expect(seatCompactionInstructions([builder])).toBe(builder.compactionInstructions)
  })
  it("labels each hat's instructions on a fused seat", () => {
    const merged = seatCompactionInstructions([builder, tester])!
    expect(merged).toContain("For the builder hat's work: Preserve code changes.")
    expect(merged).toContain("For the tester hat's work: Preserve test results.")
  })
  it("skips hats without instructions; all-absent → undefined", () => {
    expect(seatCompactionInstructions([{ id: "a" }, { id: "b" }])).toBeUndefined()
    const merged = seatCompactionInstructions([builder, { id: "b" }])!
    expect(merged).toContain("For the builder hat's work:")
    expect(merged).not.toContain("For the b hat's work:")
  })
})

describe("commonPromptPrefix", () => {
  it("factors the shared prefix back to a newline boundary", () => {
    expect(commonPromptPrefix(["SHARED\nAAA", "SHARED\nBBB"])).toBe("SHARED\n")
  })
  it("returns empty when nothing is shared or the share breaks mid-line", () => {
    expect(commonPromptPrefix(["alpha", "beta"])).toBe("")
    expect(commonPromptPrefix(["prefix same then A", "prefix same then B"])).toBe("")
  })
  it("handles the empty list", () => {
    expect(commonPromptPrefix([])).toBe("")
  })
})

describe("buildSeatSystemPrompt", () => {
  const prompt = buildSeatSystemPrompt("maker", [
    { persona: builder, logbook: "A previous occupant shipped unverified." },
    { persona: tester },
  ])
  it("opens with assignment framing naming every role", () => {
    expect(prompt).toContain('you hold the "maker" seat')
    expect(prompt).toContain("roles builder, tester")
  })
  it("factors the shared foundation out exactly once", () => {
    const matches = prompt.match(/SHARED BASE/g) ?? []
    expect(matches).toHaveLength(1)
  })
  it("gives each hat a titled section with its remainder and hands", () => {
    expect(prompt).toContain("## builder hat (Builder)")
    expect(prompt).toContain("Builder duties: implement.")
    expect(prompt).toContain("Hands of this hat: read, edit, write, bash.")
    expect(prompt).toContain("## tester hat (Tester)")
    expect(prompt).toContain("Tester duties: verify.")
  })
  it("inlines a hat's logbook in ITS section, visible to the whole seat", () => {
    expect(prompt).toContain("builder hat logbook (agent_memory/builder.md")
    expect(prompt).toContain("A previous occupant shipped unverified.")
    expect(prompt).not.toContain("tester hat logbook")
  })
})

describe("buildHatHeader", () => {
  const header = buildHatHeader(tester, "maker", [builder, tester])
  it("names the seat, the hat, its section and its hands", () => {
    expect(header).toContain("[maker seat — tester hat]")
    expect(header).toContain('"tester hat" section')
    expect(header).toContain("read, bash, grep")
    expect(header).toContain("builder")
  })
  it("stays thin — the ≤400-char decision", () => {
    expect(header.length).toBeLessThanOrEqual(400)
  })
  it("handles a hat with no tools", () => {
    const h = buildHatHeader({ id: "ghost", tools: [] }, "maker", [builder, { id: "ghost", tools: [] }])
    expect(h).toContain("none — coordinate via handoff")
  })
})

describe("hatSwitchSuffix", () => {
  const seatOf = (id: string) => (id === "builder" || id === "tester" ? "maker" : id)
  it("suffixes an intra-seat hop", () => {
    expect(hatSwitchSuffix("builder", "tester", seatOf)).toBe(" — hat switch (maker seat, context carried)")
  })
  it("stays silent across seats and on self", () => {
    expect(hatSwitchSuffix("builder", "auditor", seatOf)).toBe("")
    expect(hatSwitchSuffix("builder", "builder", seatOf)).toBe("")
  })
})
