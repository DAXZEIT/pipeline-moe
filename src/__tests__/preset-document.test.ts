// parsePresetFile — validation of preset DOCUMENTS (PUT /api/presets/:name).
// The contract under test: reject loudly with the persona named in the error
// (the author may be an LLM reading the message to fix its output), apply the
// hydration semantics on optional fields (absent = inherit, explicit [] =
// opt-out), and surface non-blocking advice as warnings.

import { describe, expect, it } from "vitest"
import { parsePresetFile, THINKING_LEVELS } from "../validation.js"

const member = (over: Record<string, unknown> = {}) => ({
  id: "scout",
  name: "Scout",
  tools: ["read", "grep"],
  ...over,
})

describe("parsePresetFile — acceptance", () => {
  it("parses a minimal document and applies defaults", () => {
    const { preset, warnings } = parsePresetFile("MyTeam", { personas: [{ name: "Scout" }] })
    expect(preset.name).toBe("MyTeam")
    expect(preset.personas).toEqual([
      {
        id: "scout",
        name: "Scout",
        color: "#888888",
        icon: "🤖",
        tools: ["read", "grep", "find", "ls"],
        active: true,
      },
    ])
    expect(warnings).toEqual([])
  })

  it("keeps the full field surface of the card", () => {
    const { preset } = parsePresetFile("t", {
      personas: [
        member({
          systemPrompt: "You plan.",
          model: "anthropic/claude-opus-4-6",
          thinkingLevel: "high",
          compactionInstructions: "Keep plans.",
          vision: false,
          skills: ["orchestrator"],
          active: false,
          parallel: true,
        }),
      ],
    })
    const p = preset.personas[0]
    expect(p).toMatchObject({
      systemPrompt: "You plan.",
      model: "anthropic/claude-opus-4-6",
      thinkingLevel: "high",
      compactionInstructions: "Keep plans.",
      vision: false,
      skills: ["orchestrator"],
      active: false,
      parallel: true,
    })
  })

  it("drops empty optional strings (absent = inherit from seed) but keeps skills: [] (explicit opt-out)", () => {
    const { preset } = parsePresetFile("t", {
      personas: [member({ systemPrompt: "  ", model: "", compactionInstructions: "", skills: [] })],
    })
    const p = preset.personas[0]
    expect("systemPrompt" in p).toBe(false)
    expect("model" in p).toBe(false)
    expect("compactionInstructions" in p).toBe(false)
    expect(p.skills).toEqual([])
  })

  it("sanitizes the preset name and slugs persona ids", () => {
    const { preset } = parsePresetFile("Mon Équipe!", {
      personas: [member({ id: "Le Scout Rapide" })],
    })
    expect(preset.name).toBe("Monquipe")
    expect(preset.personas[0].id).toBe("le-scout-rapide")
  })

  it("accepts valid handoff gates and drops an empty gates array", () => {
    const gated = parsePresetFile("t", {
      personas: [member(), member({ id: "auditor", name: "Auditor" })],
      handoffGates: [{ from: "scout", via: "auditor" }],
    })
    expect(gated.preset.handoffGates).toEqual([{ from: "scout", via: "auditor" }])
    const empty = parsePresetFile("t", { personas: [member()], handoffGates: [] })
    expect("handoffGates" in empty.preset).toBe(false)
  })
})

describe("parsePresetFile — rejection (readable, persona named)", () => {
  it("rejects an empty or unsanitizable name", () => {
    expect(() => parsePresetFile("!!!", { personas: [member()] })).toThrow(/preset name/)
  })

  it("rejects a missing or empty personas array", () => {
    expect(() => parsePresetFile("t", {})).toThrow(/`personas` must be a non-empty array/)
    expect(() => parsePresetFile("t", { personas: [] })).toThrow(/`personas` must be a non-empty array/)
  })

  it("rejects an unknown tool, naming the persona and listing valid tools", () => {
    expect(() => parsePresetFile("t", { personas: [member({ tools: ["read", "teleport"] })] })).toThrow(
      /personas\[0\] \("scout"\): unknown tool "teleport" — valid tools: .*read/,
    )
  })

  it("rejects duplicate ids", () => {
    expect(() => parsePresetFile("t", { personas: [member(), member()] })).toThrow(
      /personas\[1\]: duplicate id "scout"/,
    )
  })

  it("rejects a bad thinkingLevel, listing the enum", () => {
    expect(() => parsePresetFile("t", { personas: [member({ thinkingLevel: "ultra" })] })).toThrow(
      new RegExp(`invalid thinkingLevel "ultra" — one of: ${[...THINKING_LEVELS].join(", ")}`),
    )
  })

  it("rejects non-boolean vision and malformed skills", () => {
    expect(() => parsePresetFile("t", { personas: [member({ vision: "yes" })] })).toThrow(/`vision` must be a boolean/)
    expect(() => parsePresetFile("t", { personas: [member({ skills: ["ok", ""] })] })).toThrow(
      /`skills` must be an array of non-empty strings/,
    )
  })

  it("rejects a nameless persona", () => {
    expect(() => parsePresetFile("t", { personas: [{ id: "x" }] })).toThrow(/personas\[0\]\.name is required/)
  })

  it("rejects malformed handoff gates with the gate parser's message", () => {
    expect(() => parsePresetFile("t", { personas: [member()], handoffGates: [{ from: "scout", via: "scout" }] })).toThrow(
      /from and via must differ/,
    )
  })
})

describe("parsePresetFile — warnings (non-blocking)", () => {
  it("warns when several parallel personas are pinned to the sequential local backend", () => {
    const { warnings } = parsePresetFile("t", {
      personas: [
        member({ id: "h1", name: "H1", parallel: true, model: "local/a.gguf" }),
        member({ id: "h2", name: "H2", parallel: true, model: "local/a.gguf" }),
        member({ id: "h3", name: "H3", parallel: true, model: "anthropic/claude-haiku-4-5" }),
      ],
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toMatch(/"h1", "h2" are parallel but pinned to the local backend/)
  })

  it("does not warn for a single local parallel persona or for cloud lanes", () => {
    const { warnings } = parsePresetFile("t", {
      personas: [
        member({ id: "h1", name: "H1", parallel: true, model: "local/a.gguf" }),
        member({ id: "h2", name: "H2", parallel: true, model: "anthropic/claude-haiku-4-5" }),
      ],
    })
    expect(warnings).toEqual([])
  })

  it("warns when a gate references an id outside the roster", () => {
    const { warnings } = parsePresetFile("t", {
      personas: [member(), member({ id: "auditor", name: "Auditor" })],
      handoffGates: [{ from: "scout", via: "ghost" }],
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toMatch(/references "ghost".*inert/)
  })
})
