// The orchestrator room (docs/orchestrator-room.md): a /solo room sits OUTSIDE
// the pipeline — nothing routes into it, it hands off to no one — while holding
// the tools that command every other room.
//
// The two halves have to agree. LONE_AGENT_NOTE says "there is no one to hand
// off to and no team protocol to follow", which stays true of THIS room and
// becomes misleading about the pipeline the moment the seat can spawn one. So
// ORCHESTRATOR_NOTE is injected from the same predicate that builds the tools,
// and never from the persona's systemPrompt: that field being empty is what
// makes the room serve the operator's own ~/.pi/agent/SYSTEM.md.
//
// Sessions are real pi sessions (no LLM call — construction only), in a temp dir.

import { mkdtemp, rm } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent"
import { Registry } from "../registry.js"
import { LONE_AGENT_NOTE, ORCHESTRATOR_NOTE } from "../seat-runtime.js"
import { soloPersona } from "../personas.js"
import { rehydrateSeedFields, type PresetPersona } from "../preset-hydration.js"
import { SseHub } from "../sse.js"
import type { RoomOrchestrator } from "../orchestrator.js"
import type { Persona } from "../types.js"

let dir: string
let registry: Registry

const orchestrator = (): RoomOrchestrator => ({
  spawnRoom: vi.fn(async (o) => ({ roomId: "room-x", name: o.name, goalStatus: "running" })),
  checkRoom: vi.fn((roomId) => ({ found: false, roomId })),
  stopRoom: vi.fn(async () => true),
  destroyRoom: vi.fn(async (roomId: string) => [roomId]),
  answerRoom: vi.fn(() => true),
  pipelineStatus: vi.fn(async () => ({
    rooms: [], maxRooms: 8,
    local: { capacity: 1, inUse: 0, holders: [], waiting: 0 },
    models: [], presets: [],
  })),
})

/** A registry wired the way room-manager wires one — with, or without, the
 *  orchestrator capability. */
function makeRegistry(orch?: RoomOrchestrator): Registry {
  const authStorage = AuthStorage.create(join(dir, "auth.json"))
  const modelRegistry = ModelRegistry.create(authStorage, join(dir, "models.json"))
  const r = new Registry(
    { authStorage, modelRegistry, model: undefined },
    new SseHub(1), new Set(), dir, "solo-test", orch,
  )
  r.setSessionRoot(join(dir, "agents"))
  return r
}

const persona = (id: string, extra: Partial<Persona> = {}): Persona => ({
  id,
  name: id,
  color: "#123456",
  icon: "🧪",
  tools: ["read"],
  systemPrompt: `${id} duties.`,
  ...extra,
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pmoe-console-"))
})

afterEach(async () => {
  registry?.disposeAll()
  await rm(dir, { recursive: true, force: true })
})

describe("the solo console — grant", () => {
  test("soloPersona holds the five command tools plus pipeline_status", () => {
    const tools = soloPersona().tools
    for (const t of ["spawn_room", "check_room", "stop_room", "destroy_room", "answer_room", "pipeline_status"]) {
      expect(tools).toContain(t)
    }
  })

  test("its systemPrompt stays EMPTY — that emptiness is the pure-pi marker", () => {
    // seat-runtime's purePi test is `!systemPrompt`: writing the orchestration
    // briefing here would silently stop serving ~/.pi/agent/SYSTEM.md, which is
    // the entire reason /solo exists. The briefing lives in promptParts instead.
    expect(soloPersona().systemPrompt).toBe("")
    expect(soloPersona("local/GRM 2.6").systemPrompt).toBe("")
  })
})

describe("presets/pi-audited.json — a solo worker WITH verifiers", () => {
  // Per dax, this is where the value is: "une room solo devient simplement un
  // sub-agent, sauf qu'on peut rajouter un auditeur et pourquoi pas un Tester
  // dans la boucle". It needs no code — purePi keys on `single` (one hat in the
  // seat), not on the size of the room — so this test guards exactly that.
  const doc = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "presets", "pi-audited.json"), "utf8"),
  ) as { name: string; personas: PresetPersona[] }

  test("pi survives rehydration with an EMPTY prompt — it is not a seed id", () => {
    const [pi] = rehydrateSeedFields(doc.personas)
    expect(pi.id).toBe("pi")
    // Anything non-empty here and the room stops being pi.
    expect(pi.systemPrompt).toBe("")
  })

  test("the verifiers DO rehydrate — their prompts and skills come from the seed", () => {
    const [, auditor, tester] = rehydrateSeedFields(doc.personas)
    for (const p of [auditor, tester]) {
      expect(p.systemPrompt.length).toBeGreaterThan(0)
      expect(p.skills).toContain("live-verify")
    }
  })

  test("pi holds no orchestration tool here — an audited worker is not a console", () => {
    // Depth is an open question (docs/orchestrator-room.md); a spawn target that
    // can spawn is how an unbounded tree starts.
    const [pi] = doc.personas
    for (const t of ["spawn_room", "check_room", "stop_room", "destroy_room", "answer_room"]) {
      expect(pi.tools).not.toContain(t)
    }
  })

  test("three agents means pi keeps SYSTEM.md but gains team framing", async () => {
    registry = makeRegistry(orchestrator())
    for (const p of rehydrateSeedFields(doc.personas)) await registry.create(p)
    const prompt = registry.get("pi")!.seat.session.systemPrompt
    expect(prompt).not.toContain(LONE_AGENT_NOTE)
    expect(prompt).toContain("YOUR TEAM")
    expect(registry.get("pi")!.seat.session.getActiveToolNames()).toContain("handoff")
    expect(prompt).not.toContain(ORCHESTRATOR_NOTE)
  })
})

describe("the solo console — prompt/toolset agreement", () => {
  test("a lone console gets BOTH notes: alone in the room, commanding the pipeline", async () => {
    registry = makeRegistry(orchestrator())
    const p = await registry.create(soloPersona())
    const prompt = p.seat.session.systemPrompt
    const tools = p.seat.session.getActiveToolNames()

    // Alone here…
    expect(prompt).toContain(LONE_AGENT_NOTE)
    expect(tools).not.toContain("handoff")
    // …but not alone in the pipeline, and the prompt says so.
    expect(prompt).toContain(ORCHESTRATOR_NOTE)
    expect(tools).toContain("spawn_room")
    expect(tools).toContain("pipeline_status")
  })

  test("no orchestration tools → no note", async () => {
    registry = makeRegistry(orchestrator())
    const p = await registry.create(persona("scout"))
    expect(p.seat.session.systemPrompt).not.toContain(ORCHESTRATOR_NOTE)
    expect(p.seat.session.getActiveToolNames()).not.toContain("spawn_room")
  })

  test("tools listed but no orchestrator wired → no note either", async () => {
    // The prompt must never promise a mechanism the toolset doesn't carry.
    // Without a live orchestrator the tools are silently dropped, so the
    // briefing has to be dropped with them.
    registry = makeRegistry(undefined)
    const p = await registry.create(soloPersona())
    expect(p.seat.session.getActiveToolNames()).not.toContain("spawn_room")
    expect(p.seat.session.systemPrompt).not.toContain(ORCHESTRATOR_NOTE)
  })

  test("the note reaches a roster seat too — the planner has the same blind spot", async () => {
    registry = makeRegistry(orchestrator())
    const p = await registry.create(persona("planner", { tools: ["read", "spawn_room", "check_room"] }))
    await registry.create(persona("builder"))
    const prompt = registry.get("planner")!.seat.session.systemPrompt
    expect(prompt).toContain(ORCHESTRATOR_NOTE)
    expect(p.seat.session.getActiveToolNames()).toContain("pipeline_status")
  })

  test("the note documents the tools without claiming an identity", () => {
    // A role overlay in this slot would fight the operator's SYSTEM.md, which
    // the console keeps. Every tool it names must actually be granted with it.
    for (const t of ["pipeline_status", "spawn_room", "check_room", "answer_room", "stop_room", "destroy_room"]) {
      expect(ORCHESTRATOR_NOTE).toContain(t)
    }
    expect(ORCHESTRATOR_NOTE).not.toMatch(/\byou are (the|an?) \w/i)
  })

  test("a console that loses the capability loses the briefing on rebuild", async () => {
    // Roster mutations rebuild seats (reconcileLoneFraming); the two halves must
    // flip together, never one without the other.
    registry = makeRegistry(orchestrator())
    await registry.create(soloPersona())
    expect(registry.get("pi")!.seat.session.systemPrompt).toContain(ORCHESTRATOR_NOTE)

    await registry.update("pi", { ...soloPersona(), tools: ["read", "bash"] })
    const prompt = registry.get("pi")!.seat.session.systemPrompt
    expect(prompt).not.toContain(ORCHESTRATOR_NOTE)
    expect(registry.get("pi")!.seat.session.getActiveToolNames()).not.toContain("spawn_room")
  })
})
