import { describe, expect, test } from "vitest"
import { initialRoomState, reduce, type LivePart, type Message } from "@pipeline-moe/client-core"
import { TurnSegmenter } from "../turn-parts.js"
import type { TurnPart } from "../types.js"

// Block 2 of docs/interleaved-turns.md — the block placed before the renderers
// precisely because it is the one capable of invalidating the design.
//
// The claim under test: the sequence a client assembles WHILE a turn streams is
// the same sequence that gets persisted, by construction rather than by two
// implementations happening to agree. The construction is that the server
// stamps `seq` — its own segment identity — on every streaming frame, and the
// client only ever appends into the segment it is told. There is no boundary
// rule on the client to drift.
//
// So this test drives BOTH sides from one event script: the server's
// TurnSegmenter and client-core's pure SSE reducer, frame by frame, then
// compares what each ended up with. It is the cheap half of the block's
// verification — the live half runs against a real model on an isolated
// instance, where the events are real rather than scripted.

const AGENT = "builder"

type Step = ["reasoning" | "text", string] | ["tool", string]

/** Drive the server segmenter and the client reducer from the same script,
 *  exactly as participant.ts and an SSE client would see it. */
function play(script: Step[]): { persisted: TurnPart[] | undefined; live: LivePart[] } {
  const seg = new TurnSegmenter()
  let state = initialRoomState

  for (const [kind, payload] of script) {
    if (kind === "tool") {
      const seq = seg.tool(payload)
      const item = { toolCallId: payload, toolName: "bash", status: "running" as const, ts: Date.now() }
      state = reduce(state, { name: "activity", data: { id: AGENT, item, seq } }).state
      // The completion frame, which carries no seq on purpose.
      state = reduce(state, {
        name: "activity",
        data: { id: AGENT, item: { ...item, status: "ok" as const, result: "done", durationMs: 12 } },
      }).state
    } else {
      const seq = seg.delta(kind, payload)
      const name = kind === "text" ? "token" : "reasoning"
      state = reduce(state, { name, data: { id: AGENT, delta: payload, seq } }).state
    }
  }
  return { persisted: seg.finish(), live: state.liveParts[AGENT] ?? [] }
}

/** What the two sides have to agree on: the ORDER and the CONTENT.
 *
 *  Two normalisations, both deliberate and both the renderer's job anyway:
 *  timestamps are taken on each side at a different instant, and the server
 *  trims a segment when it closes it — which a live client cannot do, since a
 *  trailing space may still be followed by more text. A segment that trims to
 *  nothing is dropped entirely on the server, so it is dropped here too. */
function shape(parts: Array<TurnPart | LivePart> | undefined): string[] {
  return (parts ?? [])
    .map((p) => (p.type === "tool" ? `tool:${p.toolCallId}` : `${p.type}:${p.content.trim()}`))
    .filter((s) => !s.endsWith(":"))
}

describe("live assembly vs persisted parts", () => {
  test("a multi-tool turn assembles identically on both sides", () => {
    // The canonical shape: think, act, think again, reply — the turn the
    // grouped layout cannot express. Modelled on a real one
    // (sessions/solo-mrr3jne5): short thoughts before each call, then the long
    // one, including two calls back to back with nothing between them.
    const { persisted, live } = play([
      ["reasoning", "Let me check the memory file"],
      ["tool", "call-1"],
      ["reasoning", "not there. Now the README"],
      ["tool", "call-2"],
      ["tool", "call-3"],
      ["reasoning", "so there is no record of it at all"],
      ["text", "I looked — nothing in memory about that."],
    ])

    expect(shape(live)).toEqual(shape(persisted))
    expect(shape(persisted)).toEqual([
      "reasoning:Let me check the memory file",
      "tool:call-1",
      "reasoning:not there. Now the README",
      "tool:call-2",
      "tool:call-3",
      "reasoning:so there is no record of it at all",
      "text:I looked — nothing in memory about that.",
    ])
  })

  test("token-by-token streaming lands in the same segments", () => {
    // Real deltas are fragments, not whole thoughts. The client must merge
    // them on `seq` alone — the boundary is never its decision.
    const { persisted, live } = play([
      ["reasoning", "I sh"],
      ["reasoning", "ould read it"],
      ["tool", "call-1"],
      ["text", "Here"],
      ["text", " is "],
      ["text", "the answer."],
    ])
    expect(shape(live)).toEqual(shape(persisted))
    expect(shape(live)).toEqual(["reasoning:I should read it", "tool:call-1", "text:Here is the answer."])
  })

  test("a reasoning → text → reasoning flip inside one message agrees too", () => {
    const { persisted, live } = play([
      ["reasoning", "hm"],
      ["text", "One moment."],
      ["reasoning", "back to it"],
    ])
    expect(shape(live)).toEqual(shape(persisted))
    expect(shape(live)).toEqual(["reasoning:hm", "text:One moment.", "reasoning:back to it"])
  })

  test("a whitespace-only run is dropped by the server and normalises away live", () => {
    // Models routinely emit a bare "\n\n" before calling a tool. The server
    // drops that segment at close and its seq is never reused; the client
    // still holds it until the entry lands, but it has nothing to draw.
    const { persisted, live } = play([
      ["reasoning", "thinking"],
      ["tool", "call-1"],
      ["text", "\n\n"],
      ["tool", "call-2"],
      ["text", "Done."],
    ])
    expect(shape(live)).toEqual(shape(persisted))
    expect(shape(persisted)).toEqual(["reasoning:thinking", "tool:call-1", "tool:call-2", "text:Done."])
    // The divergence is real but invisible: one extra, empty, live segment.
    expect(live.length).toBe((persisted ?? []).length + 1)
  })

  test("the finished message replaces the live assembly", () => {
    // The swap that makes the whole scheme safe: whatever the live view held,
    // the authoritative parts arrive with the entry.
    const seg = new TurnSegmenter()
    let state = initialRoomState
    const seq = seg.delta("text", "partial")
    state = reduce(state, { name: "token", data: { id: AGENT, delta: "partial", seq } }).state
    expect(state.liveParts[AGENT]).toHaveLength(1)

    const msg: Message = {
      index: 0,
      author: AGENT,
      authorName: "Builder",
      text: "partial",
      ts: Date.now(),
      parts: seg.finish(),
    }
    state = reduce(state, { name: "message", data: msg }).state
    expect(state.liveParts[AGENT]).toBeUndefined()
    expect(state.messages[0].parts).toEqual([{ type: "text", content: "partial", ts: expect.any(Number) }])
  })

  test("a server that sends no seq streams exactly as before", () => {
    // Back-compat in the other direction: an older server (or a frame that
    // predates the field) must not produce a half-built sequence. It produces
    // none, which is the grouped fallback.
    let state = initialRoomState
    state = reduce(state, { name: "reasoning", data: { id: AGENT, delta: "thinking" } }).state
    state = reduce(state, { name: "token", data: { id: AGENT, delta: "hello" } }).state
    expect(state.liveParts[AGENT]).toBeUndefined()
    expect(state.liveReasoning[AGENT]).toBe("thinking")
    expect(state.streaming[AGENT]).toBe("hello")
  })
})
