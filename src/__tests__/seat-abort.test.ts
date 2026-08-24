import { describe, expect, test } from "vitest"
import { Participant } from "../participant.js"
import type { Persona } from "../types.js"

// Review 2026-08-24, #8 — a hat queued on the SEAT lock behind another hat
// could not be aborted: acquireTurn is a plain `await prev`, and
// promptRounds resets externallyAborted at round start, so a Stop pressed
// during the wait was silently lost and the queued hat ran its turn anyway.
// These tests drive a REAL Participant against a fake seat that can gate
// acquireTurn — the same seat-wait window, minus the pi session.

function makePersona(id: string): Persona {
  return { id, name: id, color: "#000", icon: "🤖", tools: [], systemPrompt: "" }
}

interface FakeSession {
  promptCalls: number
  messages: unknown[]
  isStreaming: boolean
  prompt: () => Promise<void>
  followUp: () => Promise<void>
  abort: () => Promise<void>
}

/** A fake seat exposing just the surface Participant.run()/followUp() touch.
 *  gate() makes the next acquireTurn wait until open() is called. */
function makeFakeSeat() {
  const session: FakeSession = {
    promptCalls: 0,
    messages: [],
    isStreaming: false,
    async prompt() { this.promptCalls++ },
    async followUp() {},
    async abort() {},
  }
  let gate: Promise<void> = Promise.resolve()
  let open!: () => void
  const seat: {
    seatId: string
    fused: () => boolean
    resetGuard: () => void
    setHandler: (hatId: string, handler: (ev: unknown) => void) => void
    session: FakeSession
    acquireTurn: (hatId: string) => Promise<() => void>
    gate: () => void
    open: () => void
  } = {
    seatId: "seat1",
    fused: () => false,
    resetGuard: () => {},
    setHandler: () => {}, // event fanning-out is out of scope here
    session,
    async acquireTurn() {
      await gate
      return () => {}
    },
    gate: () => {
      gate = new Promise<void>((r) => { open = r })
    },
    open: () => open(),
  }
  return { seat, session }
}

const noop = () => {}

describe("seat-wait abort (review 2026-08-24, #8)", () => {
  test("run(): a Stop while waiting for the seat never starts the turn", async () => {
    const { seat, session } = makeFakeSeat()
    const p = Participant.attach(makePersona("hat"), seat as any, noop)

    seat.gate()
    const runP = p.run("hello")
    await new Promise((r) => setTimeout(r, 20)) // queued behind the gate

    await p.abort() // what abortCurrent() does to the waiting hat
    seat.open() // the hat's turn "becomes available"

    const result = await runP
    expect(result.stopReason).toBe("aborted")
    expect(result.text).toBe("")
    expect(session.promptCalls).toBe(0) // the generation never ran
  })

  test("no stale skip: the turn AFTER a wait-abort still runs", async () => {
    const { seat, session } = makeFakeSeat()
    const p = Participant.attach(makePersona("hat"), seat as any, noop)

    // First turn: aborted while waiting.
    seat.gate()
    const first = p.run("hello")
    await new Promise((r) => setTimeout(r, 20))
    await p.abort()
    seat.open()
    await first

    // Second message: the flag consumed by the first turn must not read as a
    // fresh wait-abort — otherwise every Stop would eat the next turn.
    const second = await p.run("again")
    expect(second.stopReason).toBeUndefined()
    expect(session.promptCalls).toBe(1)
  })

  test("followUp(): the same window exists on the follow-up path", async () => {
    const { seat, session } = makeFakeSeat()
    const p = Participant.attach(makePersona("hat"), seat as any, noop)

    seat.gate()
    const fuP = p.followUp("hello")
    await new Promise((r) => setTimeout(r, 20))

    await p.abort()
    seat.open()

    const result = await fuP
    expect(result.stopReason).toBe("aborted")
    expect(session.promptCalls).toBe(0)
  })
})
