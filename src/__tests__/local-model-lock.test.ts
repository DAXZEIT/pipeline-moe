import { describe, expect, test } from "vitest"
import { LocalModelLock } from "../local-model-lock.js"
import { Room } from "../room.js"
import { SseHub } from "../sse.js"
import type { Persona } from "../types.js"

// ── LocalModelLock unit tests ──────────────────────────────────────────────

describe("LocalModelLock", () => {
  test("acquire() resolves immediately when lock is free", async () => {
    const lock = new LocalModelLock()
    expect(lock.isHeld).toBe(false)
    await lock.acquire()
    expect(lock.isHeld).toBe(true)
  })

  test("release() frees the lock when no waiters", () => {
    const lock = new LocalModelLock()
    lock.acquire()    // synchronously sets held=true (no awaiter needed)
    lock.release()
    expect(lock.isHeld).toBe(false)
    expect(lock.waitCount).toBe(0)
  })

  test("second acquire() waits until release() is called", async () => {
    const lock = new LocalModelLock()
    await lock.acquire() // first holder

    let secondResolved = false
    const second = lock.acquire().then(() => { secondResolved = true })

    // Second is queued — not yet resolved
    expect(secondResolved).toBe(false)
    expect(lock.waitCount).toBe(1)

    lock.release() // hand off to the waiter

    await second
    expect(secondResolved).toBe(true)
    expect(lock.isHeld).toBe(true)  // second caller now holds it
    expect(lock.waitCount).toBe(0)
  })

  test("multiple waiters queue in order", async () => {
    const lock = new LocalModelLock()
    await lock.acquire()  // first holder

    const order: number[] = []
    const a = lock.acquire().then(() => order.push(1))
    const b = lock.acquire().then(() => order.push(2))
    const c = lock.acquire().then(() => order.push(3))

    expect(lock.waitCount).toBe(3)

    lock.release() // → 1 gets the lock
    await a
    lock.release() // → 2 gets the lock
    await b
    lock.release() // → 3 gets the lock
    await c

    expect(order).toEqual([1, 2, 3])
  })

  test("release() when nothing was acquired is a safe no-op", () => {
    const lock = new LocalModelLock()
    expect(() => lock.release()).not.toThrow()
    expect(lock.isHeld).toBe(false)
  })

  test("lock can be reused after full acquire/release cycle", async () => {
    const lock = new LocalModelLock()
    await lock.acquire()
    lock.release()
    expect(lock.isHeld).toBe(false)

    await lock.acquire()  // should work again
    expect(lock.isHeld).toBe(true)
    lock.release()
    expect(lock.isHeld).toBe(false)
  })

  test("two concurrent acquires serialize: one runs while other waits", async () => {
    const lock = new LocalModelLock()
    const events: string[] = []

    async function work(id: string) {
      await lock.acquire()
      events.push(`${id}:start`)
      // Simulate async work
      await Promise.resolve()
      events.push(`${id}:end`)
      lock.release()
    }

    // Start both concurrently — first wins the lock
    await Promise.all([work("A"), work("B")])

    // A starts and ends before B starts
    expect(events[0]).toBe("A:start")
    expect(events[1]).toBe("A:end")
    expect(events[2]).toBe("B:start")
    expect(events[3]).toBe("B:end")
  })
})

// ── Room integration tests ─────────────────────────────────────────────────

/** A minimal mock participant whose run() resolves to a fixed reply. */
class MockParticipant {
  persona: Persona
  active = true
  parallel = false
  status: "idle" | "active" | "thinking" | "working" = "idle"
  cursor = 0
  private _reply: string
  /** Records events during run() for test inspection. */
  events: string[] = []
  private _lock?: LocalModelLock

  constructor(persona: Persona, reply = "(ok)", lock?: LocalModelLock) {
    this.persona = persona
    this._reply = reply
    this._lock = lock
  }

  async run(_text: string) {
    if (this._lock) this.events.push(`held:${this._lock.isHeld}`)
    return {
      text: this._reply,
      activity: [],
      reasoning: undefined,
      question: undefined,
    }
  }

  async followUp(_text: string) { return this.run(_text) }

  getContextUsage() { return undefined }
  getSessionStats() { return undefined }
  getAvailableThinkingLevels() { return [] }
}

class MockRegistry {
  private parts = new Map<string, MockParticipant>()
  onChange: (() => void) | null = null

  add(p: MockParticipant) { this.parts.set(p.persona.id, p) }
  has(id: string) { return this.parts.has(id) }
  get(id: string) { return this.parts.get(id) }
  roster() {
    return [...this.parts.values()].map((p) => ({
      id: p.persona.id, name: p.persona.name, color: p.persona.color,
      icon: p.persona.icon, tools: p.persona.tools, active: p.active,
      status: p.status, parallel: p.parallel,
    }))
  }
  activeParticipants() { return [...this.parts.values()].filter((p) => p.active) }
  personaStates() { return [] }
  broadcastRoster() {}
  reset(_states: any[]) {}
  setActive(id: string, active: boolean) {
    const p = this.parts.get(id)
    if (p) p.active = active
  }
  kick(id: string) { this.parts.delete(id) }
  disposeAll() {}
}

class MockStore {
  async init() {}
  async write() {}
  async read() { return null }
  async list() { return [] }
}

function makePersona(id: string, model?: string): Persona {
  return { id, name: id, color: "#000", icon: "🤖", tools: [], systemPrompt: "", ...(model ? { model } : {}) }
}

describe("Room + LocalModelLock integration", () => {
  test("local agent acquires lock during run()", async () => {
    const lock = new LocalModelLock()
    const hub = new SseHub(1)
    const registry = new MockRegistry()
    const participant = new MockParticipant(makePersona("builder"), "(done)", lock)
    registry.add(participant)

    const room = new Room(registry as any, hub, new MockStore() as any, [], "test-room", lock)

    await room.init()
    // Submit triggers executeAgent, which should acquire the lock around run()
    await new Promise<void>((resolve) => {
      room.submit("go")
      // give the turn time to complete
      setTimeout(resolve, 50)
    })

    // The participant's run() should have seen the lock held
    expect(participant.events).toContain("held:true")
    // Lock should be released after the turn
    expect(lock.isHeld).toBe(false)
  })

  test("cloud agent does NOT acquire the lock", async () => {
    const lock = new LocalModelLock()
    const hub = new SseHub(1)
    const registry = new MockRegistry()
    // Cloud agent: model is "anthropic/claude-3-5-sonnet"
    const participant = new MockParticipant(makePersona("cloud-builder", "anthropic/claude-3-5-sonnet"), "(done)", lock)
    registry.add(participant)

    const room = new Room(registry as any, hub, new MockStore() as any, [], "cloud-room", lock)

    await room.init()
    await new Promise<void>((resolve) => {
      room.submit("go")
      setTimeout(resolve, 50)
    })

    // Cloud agent should NOT have seen the lock held by it (lock stays free the whole time)
    expect(participant.events).toContain("held:false")
    expect(lock.isHeld).toBe(false)
  })

  test("lock is released even when agent run() throws", async () => {
    const lock = new LocalModelLock()
    const hub = new SseHub(1)
    const registry = new MockRegistry()

    class ThrowingParticipant extends MockParticipant {
      async run(_text: string) {
        throw new Error("inference failed")
      }
    }

    const participant = new ThrowingParticipant(makePersona("thrower"))
    registry.add(participant)

    const room = new Room(registry as any, hub, new MockStore() as any, [], "test-room", lock)
    await room.init()

    await new Promise<void>((resolve) => {
      room.submit("go")
      setTimeout(resolve, 50)
    })

    // Lock must be released even after an error
    expect(lock.isHeld).toBe(false)
  })
})
