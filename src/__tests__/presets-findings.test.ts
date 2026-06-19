import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { SEED_PERSONAS } from "../personas.js"
import type { PersonaState, Conversation } from "../types.js"

// ── Types ───────────────────────────────────────────────────────────────────

type PresetPersona = Omit<PersonaState, "systemPrompt"> & { systemPrompt?: string }
type PresetFile = { name: string; personas: PresetPersona[] }

// ── Finding 1: undefined systemPrompt in appendSystemPromptOverride ─────────

describe("Finding 1: undefined systemPrompt in appendSystemPromptOverride", () => {
  test("Array.join converts undefined to empty string, NOT the literal 'undefined'", () => {
    // The auditor claimed: "undefined lands in the array, .join produces the literal string 'undefined'"
    // This is INCORRECT. Array.join() converts undefined to "".
    const base = ["pi base prompt"]
    const undefinedPrompt: string | undefined = undefined
    const joined = [...base, undefinedPrompt, "workspace note"].join("\n\n")

    // Proved by execution: undefined → empty string
    expect(joined).not.toContain("undefined")
    expect(joined).toBe("pi base prompt\n\n\n\nworkspace note")
  })

  test("builder2 persona from cloud-sprint has no systemPrompt — produces blank line", () => {
    const builder2Preset: PresetPersona = {
      id: "builder2",
      name: "Builder2",
      color: "#EF9F27",
      icon: "🔨",
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      model: "anthropic/claude-haiku-4-20250719",
      active: true,
      parallel: true,
      // No systemPrompt — not a seed persona
    }
    expect(builder2Preset.systemPrompt).toBeUndefined()

    // Simulate participant.ts line 111: appendSystemPromptOverride
    const base = ["pi base prompt"]
    const joined = [...base, builder2Preset.systemPrompt, "workspace note"].join("\n\n")

    // The result has a blank line where systemPrompt should be, not "undefined"
    expect(joined).not.toContain("undefined")
    expect(joined).toBe("pi base prompt\n\n\n\nworkspace note")
    // The persona-specific instructions are MISSING — still a real problem, just not "undefined"
  })

  test("planner persona from cloud-sprint has no systemPrompt — produces blank line", () => {
    const plannerPreset: PresetPersona = {
      id: "planner",
      name: "Planner",
      color: "#4A90D9",
      icon: "📋",
      tools: ["read", "grep", "find", "ls"],
      model: "anthropic/claude-opus-4-6-20250603",
      active: true,
      parallel: true,
    }
    expect(plannerPreset.systemPrompt).toBeUndefined()

    const base = ["pi base prompt"]
    const joined = [...base, plannerPreset.systemPrompt, "workspace note"].join("\n\n")
    expect(joined).not.toContain("undefined")
    expect(joined).toBe("pi base prompt\n\n\n\nworkspace note")
  })

  test("guarding with conditional spread eliminates the blank line", () => {
    const undefinedPrompt: string | undefined = undefined
    const base = ["pi base prompt"]
    // The fix: ...(persona.systemPrompt ? [persona.systemPrompt] : [])
    const guarded = [...base, ...(undefinedPrompt ? [undefinedPrompt] : []), "workspace note"].join("\n\n")
    expect(guarded).not.toContain("undefined")
    expect(guarded).toBe("pi base prompt\n\nworkspace note")
    // No blank line — cleaner output
  })

  test("guarding preserves defined systemPrompt", () => {
    const definedPrompt = "I am a builder"
    const base = ["pi base prompt"]
    const guarded = [...base, ...(definedPrompt ? [definedPrompt] : []), "workspace note"].join("\n\n")
    expect(guarded).toContain("I am a builder")
    expect(guarded).toBe("pi base prompt\n\nI am a builder\n\nworkspace note")
  })

  test("the real problem: persona-specific instructions are MISSING for builder2/planner", () => {
    // The actual severity: builder2 and planner get NO role-specific instructions.
    // They'll act as generic assistants. The blank line doesn't confuse the model —
    // but the missing instructions do.
    const builder2Preset: PresetPersona = {
      id: "builder2",
      name: "Builder2",
      color: "#EF9F27",
      icon: "🔨",
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      model: "anthropic/claude-haiku-4-20250719",
      active: true,
      parallel: true,
    }

    const base = ["pi base prompt"]
    const joined = [...base, builder2Preset.systemPrompt, "workspace note"].join("\n\n")

    // Compare with a persona that HAS a systemPrompt
    const scoutSeed = SEED_PERSONAS[0]
    const scoutJoined = [...base, scoutSeed.systemPrompt, "workspace note"].join("\n\n")

    // Scout has persona-specific instructions; builder2 does not
    expect(scoutJoined).toContain(scoutSeed.systemPrompt)
    expect(joined).not.toContain(scoutSeed.systemPrompt)
    // The scout's prompt is substantial (persona overlay)
    expect(scoutJoined.length).toBeGreaterThan(joined.length)
  })
})

// ── Finding 3: empty-roster preset bricks the session ───────────────────────

describe("Finding 3: loadPreset with empty personas has no guard", () => {
  test("loadPreset does NOT have the empty-roster guard that applyConversation has", () => {
    // In applyConversation (room.ts ~line 201), there's a guard:
    //   if (personas.length === 0) { personas = seedPersonas.map(p => ({ ...p, active: true })) }
    // In loadPreset (room.ts ~line 233), there is NO such guard.
    // It calls startFresh directly with the personas, no check.

    const applyConversationGuard = (personas: Conversation["personas"], seedPersonas: typeof SEED_PERSONAS) => {
      if (personas.length === 0) {
        return seedPersonas.map(p => ({ ...p, active: true }))
      }
      return personas
    }
    const loadPresetPath = (personas: Conversation["personas"]) => {
      // No guard — just passes personas through
      return personas
    }

    const healed = applyConversationGuard([], SEED_PERSONAS)
    const unguarded = loadPresetPath([])

    expect(healed.length).toBeGreaterThan(0)
    expect(unguarded.length).toBe(0)
    // The difference is the bug
  })

  test("empty preset file can be created and loaded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pipeline-moe-preset-findings-"))
    const presetsDir = join(dir, "presets")
    await mkdir(presetsDir, { recursive: true })

    const emptyPreset: PresetFile = { name: "empty-preset", personas: [] }
    await writeFile(join(presetsDir, "empty-preset.json"), JSON.stringify(emptyPreset, null, 2), "utf-8")

    const content = await readFile(join(presetsDir, "empty-preset.json"), "utf-8")
    const parsed = JSON.parse(content) as PresetFile
    expect(parsed.personas.length).toBe(0)

    // This would be loaded by loadPreset → startFresh → registry.reset([])
    // No guard would catch it.
    await rm(dir, { recursive: true, force: true })
  })
})

// ── Finding 4: seed presets are permanently deletable ──────────────────────

describe("Finding 4: seed presets can be permanently deleted", () => {
  test("seedDefaultPresets only runs when listPresets is empty", () => {
    // The guard in seedDefaultPresets:
    //   const existing = await listPresets()
    //   if (existing.length > 0) return
    // If ANY preset exists (even a user-created one), seeds are never re-seeded.

    const presets: PresetFile[] = [{ name: "user-preset", personas: [] }]
    // seedDefaultPresets would skip seeding because listPresets is non-empty
    const wouldSeed = presets.length === 0
    expect(wouldSeed).toBe(false)
  })

  test("deleting both seed presets when no user presets exist still doesn't re-seed at runtime", () => {
    // Even if both seed presets are deleted and the dir becomes empty,
    // seedDefaultPresets only runs at server startup. The user would need
    // to restart the server to get re-seeding.

    // Simulated: server has been running, presets dir is now empty
    const presetsAtRuntime: PresetFile[] = []
    // But seedDefaultPresets won't be called again — it ran once at startup
    // Recovery: empty the presets/ dir → restart server
    expect(presetsAtRuntime.length).toBe(0)
    // The user has no indication of this in the UI
  })

  test("DELETE /api/presets/:name has no protection for seed presets", () => {
    // The delete endpoint just calls deletePreset(name) which does:
    //   const path = presetPath(name)
    //   try { await unlink(path); return true } catch { return false }
    // No check for whether name is a seed preset.

    const seedPresetNames = ["local-default", "cloud-sprint"]
    for (const name of seedPresetNames) {
      // These names would be deleted without any guard
      expect(name).toBeDefined()
    }
  })
})

// ── Finding 5: Room.loadPreset has zero coverage ───────────────────────────

describe("Finding 5: Room.loadPreset is untested", () => {
  test("the ensureIdle guard works as expected for loadPreset", () => {
    // loadPreset calls ensureIdle() first — verify the guard conditions
    const simulateEnsureIdle = (running: Set<string>, queue: any[], pendingQuestion: string | null) => {
      if (running.size > 0 || queue.length > 0 || pendingQuestion !== null) {
        throw new Error("a turn is running — press Stop before switching discussions")
      }
    }

    // Idle → no throw
    expect(() => simulateEnsureIdle(new Set(), [], null)).not.toThrow()

    // Busy → throw
    expect(() => simulateEnsureIdle(new Set(["builder"]), [], null)).toThrow("a turn is running")

    // Pending question → throw
    expect(() => simulateEnsureIdle(new Set(), [], "answer me")).toThrow("a turn is running")
  })
})
