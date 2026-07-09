import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, renameSync } from "node:fs"
import { resolve } from "node:path"
import { tmpdir } from "node:os"
import {
  extractJsonHeader,
  parsePlanContent,
  parseStepOwner,
  nextStepOwner,
  findActivePlan,
  type ParsedPlan,
} from "../plan-routing.js"
import { config } from "../config.js"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
import type { Persona } from "../types.js"

// ── Helpers ─────────────────────────────────────────────────────────────────

function makePlanFile(
  dir: string,
  id: string,
  title: string,
  status: string,
  steps: { id: number; text: string; done: boolean }[],
  body?: string,
  mtimeOffsetMs?: number,
) {
  const json = JSON.stringify({ id, title, status, steps })
  const content = body ? `${json}${body}` : json
  const path = resolve(dir, `${id}.md`)
  writeFileSync(path, content, "utf8")
  if (mtimeOffsetMs !== undefined) {
    const newMtime = Date.now() + mtimeOffsetMs
    // Use rename to set mtime reliably — writeFileSync sets atime too
    renameSync(path, path)
    // Actually, let's use utimes directly
    const { utimesSync } = require("node:fs")
    const d = new Date(newMtime)
    utimesSync(path, d, d)
  }
}

// ── extractJsonHeader ────────────────────────────────────────────────────────

describe("extractJsonHeader", () => {
  test("extracts JSON header followed by markdown body", () => {
    const content = `{"id":"abc","status":"draft"}`
      + `\n\n## Goal\nSome plan text`
    const result = extractJsonHeader(content)
    expect(result).toBe('{"id":"abc","status":"draft"}')
  })

  test("extracts JSON header with no trailing content", () => {
    const content = `{"id":"abc","status":"draft"}`
    const result = extractJsonHeader(content)
    expect(result).toBe('{"id":"abc","status":"draft"}')
  })

  test("handles nested braces in step text", () => {
    const content = `{"steps":[{"text":"use {braces}"}]}`
      + `\n\n## Body`
    const result = extractJsonHeader(content)
    expect(result).toBe('{"steps":[{"text":"use {braces}"}]}')
  })

  test("handles escaped quotes inside strings", () => {
    const content = `{"title":"say \\"hello\\""}}`
    const result = extractJsonHeader(content)
    expect(result).toBe('{"title":"say \\"hello\\""}')
  })

  test("returns null for non-JSON content", () => {
    const result = extractJsonHeader("# Not a plan file\nJust markdown")
    expect(result).toBeNull()
  })

  test("returns null for empty string", () => {
    const result = extractJsonHeader("")
    expect(result).toBeNull()
  })

  test("returns null for unbalanced braces", () => {
    const result = extractJsonHeader('{"id":"abc"')
    expect(result).toBeNull()
  })
})

// ── parsePlanContent ─────────────────────────────────────────────────────────

describe("parsePlanContent", () => {
  test("parses valid plan with body", () => {
    const content = `{"id":"abc","title":"Test Plan","status":"draft","steps":[{"id":1,"text":"[builder] Do something","done":false}]}`
      + `\n\n## Goal\nDetails`
    const result = parsePlanContent(content)
    expect(result).not.toBeNull()
    expect(result!.id).toBe("abc")
    expect(result!.title).toBe("Test Plan")
    expect(result!.status).toBe("draft")
    expect(result!.steps).toHaveLength(1)
    expect(result!.steps[0].text).toBe("[builder] Do something")
  })

  test("parses plan without body", () => {
    const content = `{"id":"abc","title":"Minimal","status":"draft","steps":[]}`
    const result = parsePlanContent(content)
    expect(result).not.toBeNull()
    expect(result!.steps).toHaveLength(0)
  })

  test("filters out invalid steps", () => {
    const content = `{"id":"abc","status":"draft","steps":[
      {"id":1,"text":"valid","done":false},
      {"id":"two","text":"bad id type","done":false},
      {"id":3,"text":42,"done":false},
      {"id":4,"text":"also bad","done":"no"}
    ]}`
    const result = parsePlanContent(content)
    expect(result).not.toBeNull()
    expect(result!.steps).toHaveLength(1)
    expect(result!.steps[0].id).toBe(1)
  })

  test("returns null when required fields missing (no id)", () => {
    const content = `{"title":"No ID","status":"draft","steps":[]}`
    const result = parsePlanContent(content)
    expect(result).toBeNull()
  })

  test("returns null when required fields missing (no status)", () => {
    const content = `{"id":"abc","title":"No Status","steps":[]}`
    const result = parsePlanContent(content)
    expect(result).toBeNull()
  })

  test("returns null when steps is not an array", () => {
    const content = `{"id":"abc","status":"draft","steps":"not-array"}`
    const result = parsePlanContent(content)
    expect(result).toBeNull()
  })

  test("returns null for pure markdown file (no JSON header)", () => {
    const content = "# Not a plan\n\nJust markdown content"
    const result = parsePlanContent(content)
    expect(result).toBeNull()
  })

  test("title defaults to empty string when missing", () => {
    const content = `{"id":"abc","status":"draft","steps":[]}`
    const result = parsePlanContent(content)
    expect(result).not.toBeNull()
    expect(result!.title).toBe("")
  })

  test("assigned_to_session is optional", () => {
    const content = `{"id":"abc","status":"draft","steps":[]}`
    const result = parsePlanContent(content)
    expect(result!.assigned_to_session).toBeUndefined()
  })

  test("assigned_to_session preserved when present", () => {
    const content = `{"id":"abc","status":"draft","steps":[],"assigned_to_session":"sess-123"}`
    const result = parsePlanContent(content)
    expect(result!.assigned_to_session).toBe("sess-123")
  })
})

// ── parseStepOwner ───────────────────────────────────────────────────────────

describe("parseStepOwner", () => {
  test("extracts owner from [builder] prefix", () => {
    expect(parseStepOwner("[builder] Fix the bug")).toBe("builder")
  })

  test("extracts owner from [tester] prefix", () => {
    expect(parseStepOwner("[tester] Run tests")).toBe("tester")
  })

  test("extracts owner with no space after bracket", () => {
    expect(parseStepOwner("[planner]Plan something")).toBe("planner")
  })

  test("returns null when no owner prefix", () => {
    expect(parseStepOwner("Just do it")).toBeNull()
  })

  test("returns null for uppercase agent id (invalid per convention)", () => {
    expect(parseStepOwner("[Builder] Do stuff")).toBeNull()
  })

  test("returns null for bracket text mid-sentence", () => {
    expect(parseStepOwner("Fix [builder] issue")).toBeNull()
  })
})

// ── nextStepOwner ────────────────────────────────────────────────────────────

describe("nextStepOwner", () => {
  test("returns null for null plan", () => {
    expect(nextStepOwner(null)).toBeNull()
  })

  test("returns null when all steps are done", () => {
    const plan: ParsedPlan = {
      id: "abc", title: "", status: "draft",
      steps: [{ id: 1, text: "[builder] Step 1", done: true }],
    }
    expect(nextStepOwner(plan)).toBeNull()
  })

  test("returns owner of first incomplete step", () => {
    const plan: ParsedPlan = {
      id: "abc", title: "", status: "draft",
      steps: [
        { id: 1, text: "[builder] Step 1", done: true },
        { id: 2, text: "[tester] Step 2", done: false },
      ],
    }
    expect(nextStepOwner(plan)).toBe("tester")
  })

  test("returns null when next incomplete step has no owner", () => {
    const plan: ParsedPlan = {
      id: "abc", title: "", status: "draft",
      steps: [
        { id: 1, text: "[builder] Done", done: true },
        { id: 2, text: "No owner step", done: false },
      ],
    }
    expect(nextStepOwner(plan)).toBeNull()
  })

  test("returns owner of first incomplete step even if later steps have owners", () => {
    const plan: ParsedPlan = {
      id: "abc", title: "", status: "draft",
      steps: [
        { id: 1, text: "[builder] Incomplete", done: false },
        { id: 2, text: "[tester] Not reached yet", done: false },
      ],
    }
    expect(nextStepOwner(plan)).toBe("builder")
  })
})

// ── findActivePlan ───────────────────────────────────────────────────────────

describe("findActivePlan", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), "plan-test-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("returns null for empty directory", async () => {
    const result = await findActivePlan(tmpDir)
    expect(result).toBeNull()
  })

  test("returns null for non-existent directory", async () => {
    const result = await findActivePlan(resolve(tmpDir, "no-such-dir"))
    expect(result).toBeNull()
  })

  test("returns null when all plans are completed", async () => {
    makePlanFile(tmpDir, "abc", "Done Plan", "completed", [])
    const result = await findActivePlan(tmpDir)
    expect(result).toBeNull()
  })

  test("returns null when all plans are archived", async () => {
    makePlanFile(tmpDir, "abc", "Archived Plan", "archived", [])
    const result = await findActivePlan(tmpDir)
    expect(result).toBeNull()
  })

  test("returns active plan with builder step", async () => {
    makePlanFile(tmpDir, "abc", "Active Plan", "draft", [
      { id: 1, text: "[builder] Step 1", done: false },
    ])
    const result = await findActivePlan(tmpDir)
    expect(result).not.toBeNull()
    expect(result!.id).toBe("abc")
  })

  test("prefers most recently modified plan", async () => {
    // Older plan (mtime -1000ms)
    makePlanFile(tmpDir, "older", "Old Plan", "draft", [
      { id: 1, text: "[builder] Old step", done: false },
    ], undefined, -1000)
    // Newer plan (mtime +1000ms)
    makePlanFile(tmpDir, "newer", "New Plan", "draft", [
      { id: 1, text: "[tester] New step", done: false },
    ], undefined, 1000)

    const result = await findActivePlan(tmpDir)
    expect(result).not.toBeNull()
    expect(result!.id).toBe("newer")
  })

  test("skips completed plans and returns active one", async () => {
    makePlanFile(tmpDir, "done", "Completed", "completed", [], undefined, 1000)
    makePlanFile(tmpDir, "active", "Still Going", "draft", [
      { id: 1, text: "[planner] Continue", done: false },
    ], undefined, -1000)

    const result = await findActivePlan(tmpDir)
    expect(result).not.toBeNull()
    expect(result!.id).toBe("active")
  })

  test("skips non-plan markdown files", async () => {
    writeFileSync(resolve(tmpDir, "notes.md"), "# Just notes\nNot a plan", "utf8")
    makePlanFile(tmpDir, "real", "Real Plan", "draft", [
      { id: 1, text: "[builder] Build", done: false },
    ])

    const result = await findActivePlan(tmpDir)
    expect(result).not.toBeNull()
    expect(result!.id).toBe("real")
  })

  test("handles JSON parse error in a plan file gracefully", async () => {
    writeFileSync(resolve(tmpDir, "broken.md"), "{invalid json", "utf8")
    makePlanFile(tmpDir, "good", "Good Plan", "draft", [
      { id: 1, text: "[tester] Test", done: false },
    ])

    const result = await findActivePlan(tmpDir)
    expect(result).not.toBeNull()
    expect(result!.id).toBe("good")
  })

  test("plan with body (JSON + trailing markdown) is parsed correctly", async () => {
    const id = "body-test"
    const json = JSON.stringify({
      id, title: "With Body", status: "draft",
      steps: [{ id: 1, text: "[builder] Build it", done: false }],
    })
    writeFileSync(resolve(tmpDir, `${id}.md`), json + "\n\n## Goal\nSome details", "utf8")

    const result = await findActivePlan(tmpDir)
    expect(result).not.toBeNull()
    expect(result!.id).toBe(id)
    expect(result!.steps).toHaveLength(1)
    expect(result!.steps[0].text).toBe("[builder] Build it")
  })
})

// ── Hermetic config.plansDir control (pure-function level) ──────────────────

describe("plansDir hermetic swap (pure findActivePlan, no Room)", () => {
  test("config.plansDir swap allows hermetic test control", async () => {
    // Verify the same idiom as sessionsDir works for plansDir
    const otherDir = mkdtempSync(resolve(tmpdir(), "plan-other-"))
    const realPlansDir = config.plansDir

    makePlanFile(otherDir, "other-plan", "Other Plan", "draft", [
      { id: 1, text: "[tester] Test it", done: false },
    ])

    ;(config as { plansDir: string }).plansDir = otherDir
    const plan = await findActivePlan()
    expect(plan).not.toBeNull()
    expect(plan!.id).toBe("other-plan")
    expect(nextStepOwner(plan)).toBe("tester")

    ;(config as { plansDir: string }).plansDir = realPlansDir
    rmSync(otherDir, { recursive: true, force: true })
  })
})

// ── Integration: Room plan-aware routing (actually drives proposeChain) ─────
//
// The pure-function tests above prove findActivePlan/nextStepOwner work in
// isolation. They do NOT prove proposeChain() in room.ts actually calls them
// and routes correctly — that's a behavioral gap the auditor has flagged
// before on this exact shape of test (circuit-breaker-recovery, PLAN-6aa1e63a:
// "structural only"). These tests construct a real Room and drive a full turn.

describe("Room integration: plan-aware routing end-to-end", () => {
  class IntMockParticipant {
    persona: Persona
    active = true
    parallel = false
    status: "idle" | "active" | "thinking" | "working" = "idle"
    cursor = 0
    calls = 0
    customMessages: Array<{ customType: string; content: string }> = []
    private _reply: string

    constructor(persona: Persona, reply = "(done)") {
      this.persona = persona
      this._reply = reply
    }

    async run(_text: string) {
      this.calls++
      return { text: this._reply, activity: [], reasoning: undefined, question: undefined }
    }

    async followUp(_text: string) { return this.run(_text) }

    async sendCustomMessage(
      message: { customType: string; content: string; display: boolean },
      _options?: unknown,
    ) {
      this.customMessages.push({ customType: message.customType, content: message.content })
    }

    getContextUsage() { return undefined }
    getSessionStats() { return undefined }
    getAvailableThinkingLevels() { return [] }
  }

  class IntMockRegistry {
    private parts = new Map<string, IntMockParticipant>()
    onChange: (() => void) | null = null
    /** Mirrors the real Registry's HandoffSink — these tests exercise the
     *  NO-handoff fallback path (plan-aware / generic), but proposeChain()
     *  calls takeHandoff() unconditionally on every reply, so it must exist. */
    private pendingHandoff = new Map<string, string>()
    add(p: IntMockParticipant) { this.parts.set(p.persona.id, p) }
    get(id: string) { return this.parts.get(id) }
    has(id: string) { return this.parts.has(id) }
    roster() { return [...this.parts.values()] }
    activeIds(): string[] { return [...this.parts.values()].filter((p) => p.active).map((p) => p.persona.id) }
    register(from: string, to: string): void { this.pendingHandoff.set(from, to) }
    takeHandoff(from: string): string | undefined {
      const to = this.pendingHandoff.get(from)
      this.pendingHandoff.delete(from)
      return to
    }
    personaStates() { return [...this.parts.values()].map((p) => ({ ...p.persona, active: p.active })) }
    broadcastRoster() {}
    reset(_states: unknown[]) {}
    setActive(id: string, active: boolean) { const p = this.parts.get(id); if (p) p.active = active }
    kick(id: string) { this.parts.delete(id) }
    disposeAll() { this.parts.clear() }
    isAllowedModel(_model: string) { return true }
    setDefaultThinkingLevel(_level: string) {}
    setAllowCloud(_v: boolean) {}
    setCompactionReserveTokens(_n: number) {}
  }

  class IntMockStore {
    async init() {}
    async write() {}
    async read() { return null }
    async list() { return [] }
    async remove(_id: string) {}
  }

  function makePersona(id: string): Persona {
    return { id, name: id, color: "#000", icon: "\u{1F916}", tools: [], systemPrompt: "" }
  }

  let tmpDir: string
  const realPlansDir = config.plansDir
  let hub: SseHub
  let registry: IntMockRegistry
  let store: IntMockStore
  let room: Room

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), "plan-room-integration-"))
    ;(config as { plansDir: string }).plansDir = tmpDir
    hub = new SseHub(1)
    store = new IntMockStore()
    registry = new IntMockRegistry()
    room = new Room(registry as any, hub, store as any, [])
  })

  afterEach(async () => {
    await room.abortCurrent()
    ;(config as { plansDir: string }).plansDir = realPlansDir
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("routes to the plan's next-step owner instead of the generic fallback", async () => {
    makePlanFile(tmpDir, "live-plan", "Live Plan", "draft", [
      { id: 1, text: "[builder] Ship the feature", done: false },
    ])

    const planner = new IntMockParticipant(makePersona("planner"), "All good here, nothing more to add.")
    const builder = new IntMockParticipant(makePersona("builder"), "(done)")
    registry.add(planner)
    registry.add(builder)
    await room.init()
    // Cap the chain to exactly one hop. Without this, the test oscillates:
    // builder's own reply also has no mention, so after builder runs, the
    // plan-aware guard correctly blocks routing back to builder (self-loop),
    // but falls through to the GENERIC fallback ("planner", a different
    // agent) — which then gets plan-aware-routed back to builder again,
    // since the plan step is still "done: false" in the fixture. Two
    // individually-correct guards ping-ponging between each other. Bounded
    // by maxChainHops in practice (not a true infinite loop), but capping to
    // 1 hop here isolates the exact behavior this test cares about: does the
    // FIRST no-mention resolution route to the plan owner.
    room.setMaxChainHops(1)

    // fallbackAgentId defaults to "planner" — since planner is also fromId here,
    // the generic-fallback self-loop guard would block it on its own. If
    // plan-aware routing didn't work, builder would NEVER be called.
    room.submit("@planner kick things off")
    await new Promise<void>((r) => setTimeout(r, 200))

    expect(builder.calls).toBe(1)
    expect(builder.customMessages.some((m) => m.customType === "plan_step_routing")).toBe(true)
  })

  test("falls through to generic fallback when the plan's next step has no owner", async () => {
    makePlanFile(tmpDir, "live-plan-2", "Live Plan 2", "draft", [
      { id: 1, text: "No owner prefix here", done: false },
    ])

    const planner = new IntMockParticipant(makePersona("planner"), "Wrapping up now.")
    const auditor = new IntMockParticipant(makePersona("auditor"), "(done)")
    registry.add(planner)
    registry.add(auditor)
    await room.init()
    room.setFallbackAgent("auditor")

    room.submit("@planner kick things off")
    await new Promise<void>((r) => setTimeout(r, 200))

    expect(auditor.calls).toBe(1)
    expect(auditor.customMessages.some((m) => m.customType === "routing_fallback")).toBe(true)
  })

  test("falls through to generic fallback when the plan owner is not in the roster", async () => {
    makePlanFile(tmpDir, "live-plan-4", "Live Plan 4", "draft", [
      { id: 1, text: "[scout] Investigate, but scout isn't in this room", done: false },
    ])

    const planner = new IntMockParticipant(makePersona("planner"), "Done for now.")
    const auditor = new IntMockParticipant(makePersona("auditor"), "(done)")
    registry.add(planner)
    registry.add(auditor)
    await room.init()
    room.setFallbackAgent("auditor")

    room.submit("@planner kick things off")
    await new Promise<void>((r) => setTimeout(r, 200))

    expect(auditor.calls).toBe(1)
  })

  test("a room with its own workspaceDir does NOT consult the global plansDir", async () => {
    // Regression guard for the cross-room plan leak: config.plansDir (the
    // MAIN workspace's plans) has an active plan owned by [builder], but this
    // room lives in its own workspace — it must not route by that plan.
    // Observed live: a sandbox room ping-ponged planner↔tester for ~11 turns
    // because the main repo's active plan had a [tester] step.
    makePlanFile(tmpDir, "main-room-plan", "Main Room Plan", "draft", [
      { id: 1, text: "[builder] A step that belongs to the MAIN room", done: false },
    ])
    const otherWs = mkdtempSync(resolve(tmpdir(), "plan-room-scoped-"))
    try {
      const scopedRoom = new Room(registry as any, hub, store as any, [], "scoped", undefined, otherWs)
      const planner = new IntMockParticipant(makePersona("planner"), "All wrapped up.")
      const builder = new IntMockParticipant(makePersona("builder"), "(done)")
      const auditor = new IntMockParticipant(makePersona("auditor"), "(done)")
      registry.add(planner)
      registry.add(builder)
      registry.add(auditor)
      await scopedRoom.init()
      scopedRoom.setMaxChainHops(1)
      scopedRoom.setFallbackAgent("auditor")

      scopedRoom.submit("@planner kick things off")
      await new Promise<void>((r) => setTimeout(r, 200))

      // The main workspace's plan must NOT have routed builder; the generic
      // fallback (auditor) runs instead.
      expect(builder.calls).toBe(0)
      expect(auditor.calls).toBe(1)
      await scopedRoom.abortCurrent()
    } finally {
      rmSync(otherWs, { recursive: true, force: true })
    }
  })

  test("a room with its own workspaceDir routes by ITS OWN workspace plans", async () => {
    const otherWs = mkdtempSync(resolve(tmpdir(), "plan-room-own-"))
    try {
      const ownPlans = resolve(otherWs, ".pi", "plans")
      mkdirSync(ownPlans, { recursive: true })
      makePlanFile(ownPlans, "scoped-plan", "Scoped Plan", "draft", [
        { id: 1, text: "[builder] A step in THIS room's workspace", done: false },
      ])
      const scopedRoom = new Room(registry as any, hub, store as any, [], "scoped2", undefined, otherWs)
      const planner = new IntMockParticipant(makePersona("planner"), "All wrapped up.")
      const builder = new IntMockParticipant(makePersona("builder"), "(done)")
      registry.add(planner)
      registry.add(builder)
      await scopedRoom.init()
      scopedRoom.setMaxChainHops(1)

      scopedRoom.submit("@planner kick things off")
      await new Promise<void>((r) => setTimeout(r, 200))

      expect(builder.calls).toBe(1)
      expect(builder.customMessages.some((m) => m.customType === "plan_step_routing")).toBe(true)
      await scopedRoom.abortCurrent()
    } finally {
      rmSync(otherWs, { recursive: true, force: true })
    }
  })

  test("plan-aware routing is suppressed during an eval-mode goal, same as generic fallback", async () => {
    makePlanFile(tmpDir, "live-plan-3", "Live Plan 3", "draft", [
      { id: 1, text: "[builder] Must not be auto-routed to during eval suppression", done: false },
    ])

    const worker = new IntMockParticipant(makePersona("worker"), "Made some progress, not mentioning anyone.")
    const builder = new IntMockParticipant(makePersona("builder"), "(done)")
    const evaluator = new IntMockParticipant(makePersona("planner"), "GOAL_MET")
    registry.add(worker)
    registry.add(builder)
    registry.add(evaluator)
    await room.init()

    room.submitGoal("@worker do the thing", { mode: "eval", evaluator: "planner", maxIterations: 3 })
    await new Promise<void>((r) => setTimeout(r, 250))

    // Builder must NOT have been auto-routed to during the initial drain —
    // plan-aware routing is suppressed for the whole eval-mode run, same as
    // the generic fallback (goalEvalSavedPlanAwareRouting).
    expect(builder.calls).toBe(0)
  })

  test("planAwareRouting=false disables plan consultation, generic fallback still applies", async () => {
    makePlanFile(tmpDir, "live-plan-5", "Live Plan 5", "draft", [
      { id: 1, text: "[builder] Should be ignored", done: false },
    ])

    const planner = new IntMockParticipant(makePersona("planner"), "Done.")
    const auditor = new IntMockParticipant(makePersona("auditor"), "(done)")
    const builder = new IntMockParticipant(makePersona("builder"), "(done)")
    registry.add(planner)
    registry.add(auditor)
    registry.add(builder)
    await room.init()
    room.setFallbackAgent("auditor")
    room.setPlanAwareRouting(false)

    room.submit("@planner kick things off")
    await new Promise<void>((r) => setTimeout(r, 200))

    expect(builder.calls).toBe(0)
    expect(auditor.calls).toBe(1)
  })
})

// ── Edge cases: real-world plan file formats ─────────────────────────────────

describe("plan-routing edge cases", () => {
  test("extractJsonHeader handles deeply nested structures", () => {
    const content = `{"data":{"nested":{"deep":{"value":"ok"}}}}` + `\n\n## Body`
    const result = extractJsonHeader(content)
    expect(result).toBe('{"data":{"nested":{"deep":{"value":"ok"}}}}')
  })

  test("parsePlanContent handles plan with assigned_to_session as non-string", () => {
    const content = `{"id":"abc","status":"draft","steps":[],"assigned_to_session":123}`
    const result = parsePlanContent(content)
    expect(result).not.toBeNull()
    expect(result!.assigned_to_session).toBeUndefined()
  })

  test("extractJsonHeader stops at first balanced object", () => {
    const content = `{"id":"first"}{"id":"second"}`
    const result = extractJsonHeader(content)
    expect(result).toBe('{"id":"first"}')
  })
})
