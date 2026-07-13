import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { SEED_PERSONAS } from "../personas.js"
import type { Persona } from "../types.js"
import {
  type PresetPersona,
  rehydrateSeedFields,
  rosterDeviatesFromPreset,
  stripSeedFields,
} from "../preset-hydration.js"

const PRESETS_DIR = join(process.cwd(), "presets")
const seedPlanner = SEED_PERSONAS.find((p) => p.id === "planner")!

/** Minimal preset-persona fixture. `active` is required on PersonaState;
 *  everything else defaults so each test states only what it exercises. */
function mk(over: Partial<PresetPersona> & { id: string }): PresetPersona {
  return {
    name: "X", color: "#000", icon: "🔧", tools: ["read"],
    active: true, ...over,
  } as PresetPersona
}

// ── Semantics: inherit-when-absent, respect-when-present ────────────────────

describe("rehydrateSeedFields — skills inheritance", () => {
  test("a seed-id persona that OMITS skills inherits the seed's skills", () => {
    // A preset saved before the orchestrator skill existed: planner, no skills.
    const preset = [mk({ id: "planner", tools: ["read", "grep", "find", "ls"] })]
    const [hydrated] = rehydrateSeedFields(preset)
    expect(hydrated.skills).toEqual(["orchestrator"])
    // sanity: the seed actually carries it, else this test proves nothing
    expect(seedPlanner.skills).toEqual(["orchestrator"])
  })

  test("an explicit `skills: []` is respected as an override, NOT overwritten", () => {
    // deliberately no skills — e.g. a sub-room worker planner
    const preset = [mk({ id: "planner", skills: [] })]
    const [hydrated] = rehydrateSeedFields(preset)
    expect(hydrated.skills).toEqual([])
  })

  test("an explicit non-empty skills override survives untouched", () => {
    const preset = [mk({ id: "planner", skills: ["some-other-skill"] })]
    const [hydrated] = rehydrateSeedFields(preset)
    expect(hydrated.skills).toEqual(["some-other-skill"])
  })

  test("tools are NEVER rehydrated — preset tools win even if they diverge from seed", () => {
    // seed planner has no write/edit; a preset planner that adds them keeps them,
    // and does NOT get the seed's orchestration tools silently merged in.
    const preset = [mk({ id: "planner", tools: ["read", "grep", "find", "ls", "write", "edit", "bash"] })]
    const [hydrated] = rehydrateSeedFields(preset)
    expect(hydrated.tools).toEqual(["read", "grep", "find", "ls", "write", "edit", "bash"])
    expect(hydrated.tools).not.toContain("spawn_room")
  })

  test("a non-seed persona (builder2) is passed through untouched", () => {
    const preset = [mk({ id: "builder2", tools: ["read", "bash"] })]
    const [hydrated] = rehydrateSeedFields(preset)
    // no seed named builder2 → nothing injected
    expect(hydrated.skills).toBeUndefined()
  })

  test("systemPrompt still rehydrates from the seed when absent", () => {
    const preset = [mk({ id: "planner" })]
    const [hydrated] = rehydrateSeedFields(preset)
    expect(hydrated.systemPrompt).toBe(seedPlanner.systemPrompt)
    expect(hydrated.systemPrompt.length).toBeGreaterThan(0)
  })
})

// ── Round-trip: strip on save, rehydrate on load ────────────────────────────

describe("stripSeedFields + rehydrateSeedFields round-trip", () => {
  test("systemPrompt is dropped on save and restored on load for seed ids", () => {
    const stripped = stripSeedFields([{ ...seedPlanner, active: true } as PresetPersona])
    expect(stripped[0].systemPrompt).toBeUndefined()
    const [restored] = rehydrateSeedFields(stripped)
    expect(restored.systemPrompt).toBe(seedPlanner.systemPrompt)
  })

  test("seed-identical skills are stripped on save, then rehydrated on load", () => {
    // planner skills == seed skills → dropped to disk so the field stays absent
    // and tracks the seed, then filled back in on load.
    const saved = stripSeedFields([{ ...seedPlanner, skills: ["orchestrator"], active: true } as PresetPersona])
    expect(saved[0].skills).toBeUndefined() // stripped: matches seed
    const [restored] = rehydrateSeedFields(saved)
    expect(restored.skills).toEqual(["orchestrator"])
  })

  test("an explicit skills override (differs from seed) is preserved on save", () => {
    const saved = stripSeedFields([{ ...seedPlanner, skills: ["orchestrator", "custom"], active: true } as PresetPersona])
    expect(saved[0].skills).toEqual(["orchestrator", "custom"]) // kept: differs
  })

  test("an explicit `skills: []` opt-out survives save and stays empty on load", () => {
    const saved = stripSeedFields([{ ...seedPlanner, skills: [], active: true } as PresetPersona])
    expect(saved[0].skills).toEqual([]) // kept: [] differs from seed's ["orchestrator"]
    const [restored] = rehydrateSeedFields(saved)
    expect(restored.skills).toEqual([]) // stays empty — no silent re-grant
  })
})

// ── Finding #1 (auditor): anti-drift is PERMANENT, not one-shot ─────────────
// The auditor's exact scenario: a preset saved when SEED had one skill must
// pick up a SECOND skill added to SEED later, with no manual preset edit.
describe("Finding #1 — skills inheritance survives a seed growing a new skill", () => {
  const seedV1: Persona[] = SEED_PERSONAS.map((p) =>
    p.id === "planner" ? { ...p, skills: ["orchestrator"] } : p)
  const seedV2: Persona[] = SEED_PERSONAS.map((p) =>
    p.id === "planner" ? { ...p, skills: ["orchestrator", "delegate"] } : p)

  test("save at seed=[orchestrator], seed later gains a skill, reload gets BOTH", () => {
    // 1. A live planner carrying v1's skill is saved to a preset.
    const onDisk = stripSeedFields(
      [{ ...seedPlanner, skills: ["orchestrator"], active: true } as PresetPersona],
      seedV1,
    )
    // Matched the seed at save time → field is absent on disk…
    expect(onDisk[0].skills).toBeUndefined()
    // 2. SEED grows a second skill; reloading the SAME preset inherits BOTH.
    const [reloaded] = rehydrateSeedFields(onDisk, seedV2)
    expect(reloaded.skills).toEqual(["orchestrator", "delegate"])
  })

  test("regression guard: the OLD keep-always behavior would MISS the new skill", () => {
    // If skills were kept on disk (pre-fix), reload sees a present field and does
    // NOT inherit — the exact drift strip-if-identical closes.
    const keptOnDisk = [{ ...seedPlanner, skills: ["orchestrator"], active: true } as PresetPersona]
    const [reloaded] = rehydrateSeedFields(keptOnDisk, seedV2)
    expect(reloaded.skills).toEqual(["orchestrator"]) // stuck — the drift we fixed
  })
})

// ── Integration: every delivered preset's planner ends up orchestration-capable ─

describe("delivered presets — planner gets the orchestrator skill after hydration", () => {
  test("each preset on disk loads and its planner (if any) inherits skills when absent", async () => {
    const files = (await readdir(PRESETS_DIR)).filter((f) => f.endsWith(".json"))
    expect(files.length).toBeGreaterThan(0)

    for (const f of files) {
      const raw = await readFile(join(PRESETS_DIR, f), "utf-8")
      const parsed = JSON.parse(raw) as { personas?: PresetPersona[] }
      if (!parsed.personas) continue
      const hydrated = rehydrateSeedFields(parsed.personas)
      const planner = hydrated.find((p) => p.id === "planner")
      if (!planner) continue
      // Either the preset explicitly set skills, or it inherited orchestrator.
      // No delivered preset sets an explicit skills override today, so every
      // planner must come out orchestrator-capable.
      expect(planner.skills, `${f} planner skills`).toEqual(["orchestrator"])
    }
  })
})

// ── Drift detection: live roster vs preset document ─────────────────────────

describe("rosterDeviatesFromPreset — the anti-false-positive invariant", () => {
  test("a roster loaded straight from a preset (seed inheritance) is ZERO drift", () => {
    // The preset on disk stores planner stripped (no systemPrompt, no skills).
    const presetDoc = [mk({ id: "planner", tools: ["read", "grep", "find", "ls"] })]
    // The LIVE roster is the rehydrated form: systemPrompt + skills filled in.
    const liveRoster = rehydrateSeedFields(presetDoc)
    expect(rosterDeviatesFromPreset(liveRoster, presetDoc)).toBe(false)
  })

  test("a cursor advancing on the live roster is NOT drift (runtime-only field)", () => {
    const presetDoc = [mk({ id: "planner" })]
    const live = rehydrateSeedFields(presetDoc).map((p) => ({ ...p, cursor: 42 }))
    expect(rosterDeviatesFromPreset(live, presetDoc)).toBe(false)
  })

  test("fusing a seat on the live roster IS drift", () => {
    const presetDoc = [mk({ id: "planner" }), mk({ id: "scribe" })]
    const live = rehydrateSeedFields(presetDoc)
    live[0] = { ...live[0], seat: "shared" }
    expect(rosterDeviatesFromPreset(live, presetDoc)).toBe(true)
  })

  test("swapping a model IS drift", () => {
    const presetDoc = [mk({ id: "builder", model: "local/qwen" })]
    const live = rehydrateSeedFields(presetDoc).map((p) => ({ ...p, model: "anthropic/opus" }))
    expect(rosterDeviatesFromPreset(live, presetDoc)).toBe(true)
  })

  test("adding an agent IS drift", () => {
    const presetDoc = [mk({ id: "planner" })]
    const live = [...rehydrateSeedFields(presetDoc), mk({ id: "builder2" })]
    expect(rosterDeviatesFromPreset(live, presetDoc)).toBe(true)
  })

  test("removing an agent IS drift", () => {
    const presetDoc = [mk({ id: "planner" }), mk({ id: "builder" })]
    const live = rehydrateSeedFields(presetDoc).filter((p) => p.id !== "builder")
    expect(rosterDeviatesFromPreset(live, presetDoc)).toBe(true)
  })

  test("toggling active IS drift", () => {
    const presetDoc = [mk({ id: "planner", active: true })]
    const live = rehydrateSeedFields(presetDoc).map((p) => ({ ...p, active: false }))
    expect(rosterDeviatesFromPreset(live, presetDoc)).toBe(true)
  })

  test("persona ORDER alone is not drift", () => {
    const presetDoc = [mk({ id: "planner" }), mk({ id: "builder" })]
    const live = rehydrateSeedFields(presetDoc).reverse()
    expect(rosterDeviatesFromPreset(live, presetDoc)).toBe(false)
  })

  test("skills-array order alone is not drift (non-seed persona)", () => {
    const presetDoc = [mk({ id: "custom", skills: ["a", "b", "c"] })]
    const live = [mk({ id: "custom", skills: ["c", "a", "b"] })]
    expect(rosterDeviatesFromPreset(live, presetDoc)).toBe(false)
  })

  test("a non-seed customized systemPrompt IS compared (drift when it differs)", () => {
    const presetDoc = [mk({ id: "custom", systemPrompt: "original" })]
    const live = [mk({ id: "custom", systemPrompt: "edited" })]
    expect(rosterDeviatesFromPreset(live, presetDoc)).toBe(true)
  })
})
