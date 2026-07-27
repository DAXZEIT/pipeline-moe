import { describe, it, expect } from "vitest"
import { validatePreset, type PresetFile } from "../index.js"

const valid: PresetFile = {
  name: "test",
  personas: [
    {
      id: "a",
      name: "A",
      color: "#fff",
      icon: "🟢",
      tools: ["read"],
      active: true,
      parallel: false,
    },
  ],
}

describe("validatePreset — non-transforming + error paths", () => {
  it("accepts a minimal persona (all optionals omitted)", () => {
    const r = validatePreset(valid)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toBe(valid) // identity — insertion order survives
  })

  it("accepts vision and skills (real presets never carry them)", () => {
    const doc = {
      ...valid,
      personas: [
        { ...valid.personas[0], vision: false, skills: ["arxiv", "searxng"] },
      ],
    }
    expect(validatePreset(doc).ok).toBe(true)
  })

  it("accepts every optional field present (cursor, seat, systemPrompt: '', thinkingLevel)", () => {
    const doc = {
      ...valid,
      personas: [
        {
          ...valid.personas[0],
          systemPrompt: "",
          model: "local/GRM 2.6",
          thinkingLevel: "xhigh",
          compactionInstructions: "keep code",
          seat: "builder-tester",
          cursor: 42,
        },
      ],
      handoffGates: [{ from: "builder", via: "auditor", when: ["src/**"] }, { from: "a", via: "b" }],
    }
    expect(validatePreset(doc).ok).toBe(true)
  })

  it("rejects an unknown top-level field (proves additionalProperties:false)", () => {
    const r = validatePreset({ ...valid, bogus: true })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].path).toBe("/bogus")
  })

  it("rejects an unknown persona field", () => {
    const doc = { ...valid, personas: [{ ...valid.personas[0], extra: 1 }] }
    const r = validatePreset(doc)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].path).toBe("/personas/0/extra")
  })

  it("rejects a bad thinkingLevel", () => {
    const doc = { ...valid, personas: [{ ...valid.personas[0], thinkingLevel: "ultra" }] }
    const r = validatePreset(doc)
    expect(r.ok).toBe(false)
  })

  it("rejects non-boolean active", () => {
    const doc = { ...valid, personas: [{ ...valid.personas[0], active: "yes" }] }
    expect(validatePreset(doc).ok).toBe(false)
  })

  // The dialect claim moved to json-schema.test.ts, where it sits next to the
  // draft-2020-12 compile that gives it meaning: asserting the constant here
  // only restated what index.ts had written two lines earlier.

  it("rejects missing required fields (name, personas)", () => {
    expect(validatePreset({ personas: valid.personas }).ok).toBe(false)
    expect(validatePreset({ name: "x" }).ok).toBe(false)
  })

  it("reports typed errors with paths and messages", () => {
    const doc = {
      name: "test",
      personas: [
        { id: "a", color: "#fff" }, // missing name, icon, tools, active; extra
        { ...valid.personas[0], extra: 1 },
      ],
    }
    const r = validatePreset(doc)
    expect(r.ok).toBe(false)
    if (r.ok) return
    const paths = r.errors.map((e) => e.path)
    expect(paths).toContain("/personas/0/name")
    expect(paths).toContain("/personas/0/icon")
    expect(paths).toContain("/personas/0/tools")
    expect(paths).toContain("/personas/0/active")
    expect(paths).toContain("/personas/1/extra")
    for (const e of r.errors) expect(e.message.length).toBeGreaterThan(0)
  })

  it("preserves insertion order — re-serialization of validated output is identity", () => {
    const doc = {
      name: "order",
      personas: [
        {
          parallel: true,
          cursor: 0,
          seat: "x",
          tools: ["read"],
          id: "a",
          active: true,
          name: "A",
          color: "#fff",
          icon: "🟢",
          systemPrompt: "hello",
        },
      ],
    }
    const r = validatePreset(doc)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(JSON.stringify(r.value, null, 2)).toBe(JSON.stringify(doc, null, 2))
  })
})
