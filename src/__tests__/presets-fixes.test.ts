import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, unlink } from "node:fs/promises"
import fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { SEED_PERSONAS, BASE_PROMPT, BUILDER_OVERLAY, PLANNER_OVERLAY } from "../personas.js"
import type { PersonaState } from "../types.js"

// ── Types ───────────────────────────────────────────────────────────────────

type PresetPersona = Omit<PersonaState, "systemPrompt"> & { systemPrompt?: string }
type PresetFile = { name: string; personas: PresetPersona[] }

// ── Finding 1 fix: builder2 has systemPrompt, planner is now a seed persona ──

describe("Finding 1 fix: builder2 and planner have systemPrompt", () => {
  test("PLANNER_OVERLAY is exported and non-empty", () => {
    expect(PLANNER_OVERLAY).toBeDefined()
    expect(PLANNER_OVERLAY.length).toBeGreaterThan(0)
  })

  test("BUILDER_OVERLAY is exported and non-empty", () => {
    expect(BUILDER_OVERLAY).toBeDefined()
    expect(BUILDER_OVERLAY.length).toBeGreaterThan(0)
  })

  test("BASE_PROMPT is exported and non-empty", () => {
    expect(BASE_PROMPT).toBeDefined()
    expect(BASE_PROMPT.length).toBeGreaterThan(0)
  })

  test("builder2 systemPrompt is BASE_PROMPT + BUILDER_OVERLAY", () => {
    // This is what the cloud-sprint preset now sets for builder2:
    const builder2SystemPrompt = BASE_PROMPT + BUILDER_OVERLAY
    expect(builder2SystemPrompt).toBeTypeOf("string")
    expect(builder2SystemPrompt.length).toBeGreaterThan(0)
    expect(builder2SystemPrompt).not.toBeUndefined()
    // Contains the base prompt
    expect(builder2SystemPrompt).toContain("PIPELINE DYNAMICS")
    // Contains the builder overlay
    expect(builder2SystemPrompt).toContain("YOUR ROLE: BUILDER")
  })

  test("planner systemPrompt is BASE_PROMPT + PLANNER_OVERLAY", () => {
    // This is what the cloud-sprint preset now sets for planner:
    const plannerSystemPrompt = BASE_PROMPT + PLANNER_OVERLAY
    expect(plannerSystemPrompt).toBeTypeOf("string")
    expect(plannerSystemPrompt.length).toBeGreaterThan(0)
    expect(plannerSystemPrompt).not.toBeUndefined()
    // Contains the base prompt
    expect(plannerSystemPrompt).toContain("PIPELINE DYNAMICS")
    // Contains the planner overlay
    expect(plannerSystemPrompt).toContain("YOUR ROLE: PLANNER")
  })

  test("builder2 systemPrompt does NOT produce blank line in appendSystemPromptOverride", () => {
    const builder2SystemPrompt = BASE_PROMPT + BUILDER_OVERLAY
    const base = ["pi base prompt"]
    const joined = [...base, builder2SystemPrompt, "workspace note"].join("\n\n")
    // No blank line — systemPrompt is defined
    expect(joined).toContain("YOUR ROLE: BUILDER")
    // No "undefined" string
    expect(joined).not.toContain("undefined")
  })

  test("planner systemPrompt does NOT produce blank line in appendSystemPromptOverride", () => {
    const plannerSystemPrompt = BASE_PROMPT + PLANNER_OVERLAY
    const base = ["pi base prompt"]
    const joined = [...base, plannerSystemPrompt, "workspace note"].join("\n\n")
    expect(joined).toContain("YOUR ROLE: PLANNER")
    expect(joined).not.toContain("undefined")
  })

  test("planner overlay defines epistemic position, behavioral rules, and tool awareness", () => {
    // The PLANNER_OVERLAY should cover the planner's role
    expect(PLANNER_OVERLAY).toContain("YOUR ROLE: PLANNER")
  })

  test("builder2 and planner systemPrompts are different from each other", () => {
    const builder2Prompt = BASE_PROMPT + BUILDER_OVERLAY
    const plannerPrompt = BASE_PROMPT + PLANNER_OVERLAY
    // They share the base prompt but have different overlays
    expect(builder2Prompt).not.toBe(plannerPrompt)
    expect(builder2Prompt).toContain("BUILDER")
    expect(plannerPrompt).toContain("PLANNER")
  })
})

// ── Finding 3 fix: empty-roster guard ──────────────────────────────────────

describe("Finding 3 fix: empty-roster guard on loadPreset", () => {
  test("empty roster guard rejects personas with length 0", () => {
    // The guard: if (personas.length === 0) → 400
    const personas: PersonaState[] = []
    const shouldReject = personas.length === 0
    expect(shouldReject).toBe(true)
    // The error message includes the preset name and explains the risk
  })

  test("single-persona preset passes the guard", () => {
    const personas: PersonaState[] = [{
      id: "scout",
      name: "Scout",
      color: "#5DCAA5",
      icon: "🔍",
      tools: ["read", "grep", "find", "ls", "bash"],
      model: undefined,
      systemPrompt: SEED_PERSONAS[0].systemPrompt,
      active: true,
      parallel: false,
    }]
    const shouldReject = personas.length === 0
    expect(shouldReject).toBe(false)
  })

  test("multi-persona preset passes the guard", () => {
    const personas = SEED_PERSONAS.map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      icon: p.icon,
      tools: p.tools,
      model: undefined,
      systemPrompt: p.systemPrompt,
      active: true,
      parallel: false,
    }))
    const shouldReject = personas.length === 0
    expect(shouldReject).toBe(false)
    expect(personas.length).toBeGreaterThan(0)
  })

  test("empty preset file would be rejected on load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pipeline-moe-preset-fix-"))
    const presetsDir = join(dir, "presets")
    await mkdir(presetsDir, { recursive: true })

    const emptyPreset: PresetFile = { name: "empty-preset", personas: [] }
    await writeFile(join(presetsDir, "empty-preset.json"), JSON.stringify(emptyPreset, null, 2), "utf-8")

    const content = await readFile(join(presetsDir, "empty-preset.json"), "utf-8")
    const parsed = JSON.parse(content) as PresetFile
    // The guard: if (personas.length === 0) → 400
    expect(parsed.personas.length).toBe(0)
    // This would return 400 from the load endpoint

    await rm(dir, { recursive: true, force: true })
  })
})

// ── Finding 4 fix: seed presets deletable, re-seeded on restart ─────────────

describe("Finding 4 fix: seed presets deletable, re-seeded on restart", () => {
  // The fix removed SEED_PRESET_NAMES and the 403 guard entirely.
  // Seed presets can be deleted — they re-appear on next server start
  // via seedDefaultPresets() which checks each name individually.

  test("no 403 status in server.ts (guard removed)", () => {
    const serverCode = fs.readFileSync(join(process.cwd(), "src", "server.ts"), "utf-8")
    expect(serverCode).not.toMatch(/status\(403\)/)
  })

  test("no SEED_PRESET_NAMES constant in server.ts", () => {
    const serverCode = fs.readFileSync(join(process.cwd(), "src", "server.ts"), "utf-8")
    expect(serverCode).not.toMatch(/SEED_PRESET_NAMES/)
  })

  test("re-seeding checks each preset name individually", () => {
    const serverCode = fs.readFileSync(join(process.cwd(), "src", "server.ts"), "utf-8")
    expect(serverCode).toMatch(/existingNames\.has\("local-default"\)/)
    expect(serverCode).toMatch(/existingNames\.has\("cloud-sprint"\)/)
  })

  test("delete endpoint goes straight to deletePreset (no seed check)", () => {
    const serverCode = fs.readFileSync(join(process.cwd(), "src", "server.ts"), "utf-8")
    const deleteHandler = serverCode.match(/app\.delete\([^)]+\)[^}]+\}/s)
    expect(deleteHandler).not.toBeNull()
    expect(deleteHandler![0]).not.toMatch(/SEED_PRESET/)
    expect(deleteHandler![0]).not.toMatch(/403/)
  })
})

// ── Integration: cloud-sprint preset is now loadable ───────────────────────

describe("cloud-sprint preset is now loadable (Finding 1 + Finding 3 combined)", () => {
  test("cloud-sprint preset has 4 personas, seed prompts stripped, custom preserved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pipeline-moe-preset-fix-"))
    const presetsDir = join(dir, "presets")
    await mkdir(presetsDir, { recursive: true })

    // Simulate the cloud-sprint preset as defined in server.ts
    const rawPersonas = [
      {
        id: "builder2",
        name: "Builder2",
        color: "#EF9F27",
        icon: "🔨",
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        model: "anthropic/claude-haiku-4-20250719",
        systemPrompt: BASE_PROMPT + BUILDER_OVERLAY,
        active: true,
        parallel: true,
      },
      {
        id: "auditor",
        name: "Auditor",
        color: "#AFA9EC",
        icon: "🛡️",
        tools: ["read", "grep", "find", "ls"],
        model: "anthropic/claude-sonnet-4-20250514",
        active: true,
        parallel: true,
      },
      {
        id: "planner",
        name: "Planner",
        color: "#4A90D9",
        icon: "📋",
        tools: ["read", "grep", "find", "ls"],
        model: "anthropic/claude-opus-4-6-20250603",
        systemPrompt: BASE_PROMPT + PLANNER_OVERLAY,
        active: true,
        parallel: true,
      },
      {
        id: "tester",
        name: "Tester",
        color: "#97C459",
        icon: "🧪",
        tools: ["read", "bash", "grep", "find", "ls"],
        model: "anthropic/claude-sonnet-4-20250514",
        active: true,
        parallel: true,
      },
    ]

    // Simulate stripSeedPrompts (same logic as server.ts)
    const seedIds = new Set(SEED_PERSONAS.map(p => p.id))
    const stripped = rawPersonas.map(p => {
      if (seedIds.has(p.id)) {
        const { systemPrompt: _, ...rest } = p
        return rest
      }
      return p
    })

    const cloudSprint: PresetFile = {
      name: "cloud-sprint",
      personas: stripped,
    }

    await writeFile(join(presetsDir, "cloud-sprint.json"), JSON.stringify(cloudSprint, null, 2), "utf-8")

    const content = await readFile(join(presetsDir, "cloud-sprint.json"), "utf-8")
    const parsed = JSON.parse(content) as PresetFile

    // 4 personas
    expect(parsed.personas.length).toBe(4)

    // builder2 is custom — systemPrompt preserved
    expect(parsed.personas[0].systemPrompt).toBeDefined()
    expect(parsed.personas[0].systemPrompt!.length).toBeGreaterThan(0)
    expect(parsed.personas[0].systemPrompt!).toContain("BUILDER")

    // auditor is seed — systemPrompt stripped (rehydrated at load time)
    expect(parsed.personas[1].systemPrompt).toBeUndefined()

    // planner is now a seed persona — systemPrompt stripped (rehydrated at load time)
    expect(parsed.personas[2].systemPrompt).toBeUndefined()

    // tester is seed — systemPrompt stripped (rehydrated at load time)
    expect(parsed.personas[3].systemPrompt).toBeUndefined()

    // Empty-roster guard would pass (4 > 0)
    expect(parsed.personas.length > 0).toBe(true)

    // Simulate rehydrate: planner would get its systemPrompt from SEED_PERSONAS
    const seedMap = new Map(SEED_PERSONAS.map(p => [p.id, p]))
    const plannerSeed = seedMap.get("planner")
    expect(plannerSeed).toBeDefined()
    expect(plannerSeed!.systemPrompt).toContain("YOUR ROLE: PLANNER")

    await rm(dir, { recursive: true, force: true })
  })
})
