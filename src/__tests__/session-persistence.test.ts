// Persistent per-agent pi sessions: the SessionManager round-trip that
// Participant.resumed relies on, and the Room wiring that scopes session
// roots per conversation, persists cursors, and cleans up session dirs.

import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
import { ConversationStore } from "../store.js"
import type { Persona, PersonaState } from "../types.js"

// ── pi SessionManager round-trip ─────────────────────────────────────────
// Participant.create detects a resumed session via
// continueRecent(...).buildSessionContext().messages.length > 0. Verify that
// exact contract against the real pi implementation.

/** Minimal assistant message — pi lazily flushes a session file only once the
 *  first assistant message lands (so abandoned empty sessions leave no file).
 *  Every real turn produces one, so the persisted-session contract requires it. */
function assistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  } as never
}

describe("pi session round-trip (the `resumed` contract)", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pmoe-pi-session-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("a fresh dir yields an empty session (resumed=false)", () => {
    const sm = SessionManager.continueRecent(dir, dir)
    expect(sm.buildSessionContext().messages.length).toBe(0)
  })

  test("continueRecent reopens the same session with its messages (resumed=true)", () => {
    const sm1 = SessionManager.continueRecent(dir, dir)
    sm1.appendMessage({ role: "user", content: "remember the magic word: xyzzy", timestamp: Date.now() })
    sm1.appendMessage(assistantMessage("xyzzy noted."))

    const sm2 = SessionManager.continueRecent(dir, dir)
    const ctx = sm2.buildSessionContext()
    expect(ctx.messages.length).toBe(2)
    // Same file reopened — not a second session created next to the first.
    expect(sm2.getSessionFile()).toBe(sm1.getSessionFile())
  })

  test("distinct dirs are isolated (conversation switch cannot leak context)", () => {
    const other = mkdtempSync(join(tmpdir(), "pmoe-pi-session-b-"))
    try {
      const sm1 = SessionManager.continueRecent(dir, dir)
      sm1.appendMessage({ role: "user", content: "secret", timestamp: Date.now() })
      sm1.appendMessage(assistantMessage("kept."))
      const sm2 = SessionManager.continueRecent(other, other)
      expect(sm2.buildSessionContext().messages.length).toBe(0)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

// ── Room wiring ──────────────────────────────────────────────────────────
// Real ConversationStore on a temp dir; Registry double that records the
// session root and reset states the Room hands it.

function makePersona(id: string): Persona {
  return { id, name: id, color: "#000", icon: "🤖", tools: [], systemPrompt: "go" }
}

class MockRegistry {
  private states = new Map<string, PersonaState>()
  sessionRoot: string | null = null
  lastResetStates: PersonaState[] = []
  onChange: (() => void) | null = null

  constructor(initial: Persona[]) {
    for (const p of initial) this.states.set(p.id, { ...p, active: true })
  }

  setSessionRoot(root: string | null) {
    this.sessionRoot = root
  }
  async reset(states: PersonaState[]) {
    this.lastResetStates = states
    this.states.clear()
    for (const s of states) this.states.set(s.id, s)
  }
  personaStates(): PersonaState[] {
    return [...this.states.values()]
  }
  has(id: string) {
    return this.states.has(id)
  }
  get() {
    return undefined
  }
  activeParticipants() {
    return []
  }
  roster() {
    return [...this.states.values()]
  }
  setDefaultThinkingLevel() {}
  setAllowCloud() {}
  setCompactionReserveTokens() {}
  broadcastRoster() {}
  disposeAll() {
    this.states.clear()
  }
}

describe("Room session-root wiring", () => {
  let tmp: string
  let store: ConversationStore
  let registry: MockRegistry
  let room: Room

  const seeds = [makePersona("scout"), makePersona("builder")]

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "pmoe-room-persist-"))
    store = new ConversationStore(tmp)
    registry = new MockRegistry(seeds)
    room = new Room(registry as any, new SseHub(1), store, seeds)
    await room.init() // no saved conversations → startFresh with the seeds
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  const convId = () => (room as any).convId as string

  test("startFresh scopes the session root to the new conversation", () => {
    expect(registry.sessionRoot).toBe(resolve(tmp, "agents", convId()))
  })

  test("saveCurrent persists per-agent cursors and applyConversation hands them back", async () => {
    // Simulate an agent having advanced through the transcript.
    const st = registry.personaStates().find((s) => s.id === "scout")!
    st.cursor = 7
    await room.saveCurrent()

    const onDisk = JSON.parse(readFileSync(join(tmp, `${convId()}.json`), "utf8"))
    expect(onDisk.personas.find((p: PersonaState) => p.id === "scout").cursor).toBe(7)

    // Leave and come back: the saved cursor must flow into registry.reset.
    const firstId = convId()
    await room.newConversation("second")
    expect(convId()).not.toBe(firstId)
    expect(registry.sessionRoot).toBe(resolve(tmp, "agents", convId()))

    await room.switchConversation(firstId)
    expect(registry.sessionRoot).toBe(resolve(tmp, "agents", firstId))
    expect(registry.lastResetStates.find((s) => s.id === "scout")?.cursor).toBe(7)
  })

  test("deleteConversation removes the conversation's agent-session dir", async () => {
    const firstId = convId()
    const agentDir = resolve(tmp, "agents", firstId, "scout")
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, "s.jsonl"), "{}\n")

    await room.newConversation("other") // can't delete the live one first
    await room.deleteConversation(firstId)
    expect(existsSync(resolve(tmp, "agents", firstId))).toBe(false)
  })

  test("applyPreset wipes the current conversation's agent sessions", async () => {
    const agentDir = resolve(tmp, "agents", convId(), "scout")
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, "s.jsonl"), "{}\n")

    await room.applyPreset([{ ...makePersona("fresh"), active: true }])
    expect(existsSync(resolve(tmp, "agents", convId()))).toBe(false)
  })
})
