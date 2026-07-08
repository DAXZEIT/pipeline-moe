import { describe, expect, test } from "vitest"
import type { PresetFile } from "@pipeline-moe/client-core"
import { presetPickerLayout, presetSummary, previewPersonas } from "../preset-picker"

function persona(overrides: Partial<PresetFile["personas"][number]> = {}): PresetFile["personas"][number] {
  return {
    id: "builder",
    name: "Builder",
    color: "#EF9F27",
    icon: "🔨",
    tools: ["read", "bash"],
    active: true,
    parallel: false,
    ...overrides,
  }
}

function preset(personas: PresetFile["personas"], name = "main"): PresetFile {
  return { name, personas }
}

describe("presetSummary", () => {
  test("joins icons and pluralizes the agent count", () => {
    const p = preset([persona({ icon: "📋" }), persona({ icon: "🔨" }), persona({ icon: "🧪" })])
    expect(presetSummary(p)).toBe("📋🔨🧪  3 agents")
  })

  test("singular for exactly one agent", () => {
    const p = preset([persona({ icon: "🔨" })])
    expect(presetSummary(p)).toBe("🔨  1 agent")
  })

  test("empty preset — no icons, 0 agents", () => {
    expect(presetSummary(preset([]))).toBe("  0 agents")
  })
})

describe("presetPickerLayout", () => {
  test("caps the list window at 4 even with many presets", () => {
    const { listVisible } = presetPickerLayout(40, 20)
    expect(listVisible).toBe(4)
  })

  test("list window shrinks to the actual preset count when smaller than the cap", () => {
    const { listVisible } = presetPickerLayout(40, 2)
    expect(listVisible).toBe(2)
  })

  test("preview gets the remaining budget after the list and fixed chrome", () => {
    // budget = max(8, 40-10) = 30; listVisible = 4; previewMax = 30 - 4 - 3 = 23
    const { listVisible, previewMax } = presetPickerLayout(40, 20)
    expect(listVisible).toBe(4)
    expect(previewMax).toBe(23)
  })

  test("both floor at a usable minimum on a very short terminal", () => {
    const { listVisible, previewMax } = presetPickerLayout(5, 20)
    expect(listVisible).toBeGreaterThanOrEqual(1)
    expect(previewMax).toBeGreaterThanOrEqual(2)
  })

  test("zero presets still returns a sane, non-negative layout", () => {
    // listVisible floors at 1 even for a count of 0 — harmless, since the
    // component's empty-state branch never actually renders the windowed
    // list when presets.length === 0.
    const { listVisible, previewMax } = presetPickerLayout(40, 0)
    expect(listVisible).toBe(1)
    expect(previewMax).toBeGreaterThanOrEqual(2)
  })
})

describe("previewPersonas", () => {
  test("undefined preset — nothing shown, nothing hidden", () => {
    expect(previewPersonas(undefined, 5)).toEqual({ shown: [], hidden: 0 })
  })

  test("fits entirely within max — nothing hidden", () => {
    const personas = [persona({ id: "a" }), persona({ id: "b" })]
    const { shown, hidden } = previewPersonas(preset(personas), 5)
    expect(shown).toHaveLength(2)
    expect(hidden).toBe(0)
  })

  test("truncates and reports the exact hidden count", () => {
    const personas = Array.from({ length: 8 }, (_, i) => persona({ id: `p${i}` }))
    const { shown, hidden } = previewPersonas(preset(personas), 3)
    expect(shown).toHaveLength(3)
    expect(shown.map((p) => p.id)).toEqual(["p0", "p1", "p2"])
    expect(hidden).toBe(5)
  })

  test("max of 0 — everything hidden", () => {
    const personas = [persona({ id: "a" }), persona({ id: "b" })]
    const { shown, hidden } = previewPersonas(preset(personas), 0)
    expect(shown).toHaveLength(0)
    expect(hidden).toBe(2)
  })
})
