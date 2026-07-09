import { describe, expect, it } from "vitest"
import {
  initialRoomState,
  reduce,
  resetTransient,
  SSE_EVENT_NAMES,
  type RoomState,
  type SseEventName,
} from "../state"
import type { Message, RosterItem, ToolActivity } from "../types"

// ── helpers ──────────────────────────────────────────────────────────────────

const baseState = (partial: Partial<RoomState> = {}): RoomState => ({ ...initialRoomState, ...partial })

const apply = (state: RoomState, name: SseEventName, data: unknown) => reduce(state, { name, data })

const rosterItem = (partial: Partial<RosterItem> & { id: string }): RosterItem => ({
  name: partial.id,
  color: "#fff",
  icon: "🤖",
  tools: [],
  active: true,
  status: "idle",
  parallel: false,
  ...partial,
})

const msg = (partial: Partial<Message> & { index: number; author: string }): Message => ({
  authorName: partial.author,
  text: "",
  ts: 0,
  ...partial,
})

const activity = (partial: Partial<ToolActivity> & { toolCallId: string }): ToolActivity => ({
  toolName: "Bash",
  status: "running",
  ts: 0,
  ...partial,
})

// ── purity ───────────────────────────────────────────────────────────────────

describe("reduce — purity", () => {
  it("never mutates the input state", () => {
    const state = baseState({ roster: [rosterItem({ id: "a" })], messages: [msg({ index: 0, author: "a" })] })
    const snapshot = structuredClone(state)
    apply(state, "token", { id: "a", delta: "hi" })
    apply(state, "status", { id: "a", status: "working" })
    apply(state, "message", { index: 1, author: "a", authorName: "a", text: "x", ts: 1 })
    expect(state).toEqual(snapshot)
  })

  it("returns the same state reference for unknown/no-op events", () => {
    const state = baseState()
    const { state: next } = reduce(state, { name: "notice" as SseEventName, data: { msg: "x" } })
    expect(next).toBe(state)
  })

  it("declares every named SSE event the server can emit", () => {
    // Guards against the list drifting out of sync with the reducer's cases.
    expect(SSE_EVENT_NAMES).toContain("token")
    expect(SSE_EVENT_NAMES).toContain("oauth_progress")
    expect(new Set(SSE_EVENT_NAMES).size).toBe(SSE_EVENT_NAMES.length)
  })
})

// ── roster / status ──────────────────────────────────────────────────────────

describe("reduce — roster & status", () => {
  it("replaces the roster wholesale", () => {
    const next = apply(baseState(), "roster", [rosterItem({ id: "a" })]).state
    expect(next.roster).toHaveLength(1)
    expect(next.roster[0].id).toBe("a")
  })

  it("updates an agent's status by id, leaving others untouched", () => {
    const state = baseState({ roster: [rosterItem({ id: "a" }), rosterItem({ id: "b" })] })
    const next = apply(state, "status", { id: "b", status: "working" }).state
    expect(next.roster[0].status).toBe("idle")
    expect(next.roster[1].status).toBe("working")
  })

  it("preserves the last contextUsage when a mid-turn status omits it", () => {
    const usage = { tokens: 100, contextWindow: 1000, percent: 10 }
    const state = baseState({ roster: [rosterItem({ id: "a", contextUsage: usage })] })
    const next = apply(state, "status", { id: "a", status: "working" }).state
    expect(next.roster[0].contextUsage).toEqual(usage)
  })

  it("updates contextUsage, sessionStats and retry when the payload carries them", () => {
    const state = baseState({ roster: [rosterItem({ id: "a" })] })
    const contextUsage = { tokens: 5, contextWindow: 10, percent: 50 }
    const retry = { attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: "boom" }
    const next = apply(state, "status", { id: "a", status: "retrying", contextUsage, retry }).state
    expect(next.roster[0].contextUsage).toEqual(contextUsage)
    expect(next.roster[0].retry).toEqual(retry)
  })
})

// ── streaming buffers: token / activity / reasoning ─────────────────────────

describe("reduce — streaming buffers", () => {
  it("accumulates token deltas per agent", () => {
    let state = baseState()
    state = apply(state, "token", { id: "a", delta: "Hel" }).state
    state = apply(state, "token", { id: "a", delta: "lo" }).state
    state = apply(state, "token", { id: "b", delta: "!" }).state
    expect(state.streaming).toEqual({ a: "Hello", b: "!" })
  })

  it("appends a new tool activity, then updates it in place by toolCallId", () => {
    let state = baseState()
    state = apply(state, "activity", { id: "a", item: activity({ toolCallId: "t1", status: "running" }) }).state
    state = apply(state, "activity", { id: "a", item: activity({ toolCallId: "t2", status: "running" }) }).state
    expect(state.liveActivity.a).toHaveLength(2)
    state = apply(state, "activity", { id: "a", item: activity({ toolCallId: "t1", status: "ok" }) }).state
    expect(state.liveActivity.a).toHaveLength(2)
    expect(state.liveActivity.a[0]).toMatchObject({ toolCallId: "t1", status: "ok" })
  })

  it("accumulates reasoning deltas per agent", () => {
    let state = baseState()
    state = apply(state, "reasoning", { id: "a", delta: "think" }).state
    state = apply(state, "reasoning", { id: "a", delta: "ing" }).state
    expect(state.liveReasoning.a).toBe("thinking")
  })
})

// ── message / receipt ────────────────────────────────────────────────────────

describe("reduce — message & receipt", () => {
  it("appends a user message without touching live buffers", () => {
    const state = baseState({ streaming: { a: "partial" }, liveActivity: { a: [activity({ toolCallId: "t" })] } })
    const next = apply(state, "message", msg({ index: 0, author: "user", text: "hi" })).state
    expect(next.messages).toHaveLength(1)
    expect(next.streaming).toEqual({ a: "partial" })
    expect(next.liveActivity.a).toHaveLength(1)
  })

  it("clears only the authoring agent's live buffers when its message lands", () => {
    const state = baseState({
      streaming: { a: "partial", b: "other" },
      liveActivity: { a: [activity({ toolCallId: "t" })] },
      liveReasoning: { a: "r" },
    })
    const next = apply(state, "message", msg({ index: 0, author: "a", text: "done" })).state
    expect(next.streaming).toEqual({ b: "other" })
    expect(next.liveActivity).toEqual({})
    expect(next.liveReasoning).toEqual({})
  })

  it("attaches a receipt to the author's most recent message, keyed by index", () => {
    const state = baseState({
      messages: [
        msg({ index: 0, author: "a" }),
        msg({ index: 1, author: "b" }),
        msg({ index: 2, author: "a" }),
      ],
    })
    const receipt = { participantId: "a", created: ["x"], modified: [], deleted: [] }
    const next = apply(state, "receipt", receipt).state
    expect(next.receipts[2]).toEqual(receipt)
    expect(next.receipts[0]).toBeUndefined()
  })

  it("ignores a receipt with no matching message", () => {
    const state = baseState({ messages: [msg({ index: 0, author: "a" })] })
    const next = apply(state, "receipt", { participantId: "ghost", created: [], modified: [], deleted: [] }).state
    expect(next).toBe(state)
  })
})

// ── turn lifecycle ───────────────────────────────────────────────────────────

describe("reduce — turn lifecycle", () => {
  it("start sets the turn active, records the agent, and clears buffers", () => {
    const state = baseState({ streaming: { a: "x" }, liveActivity: { a: [activity({ toolCallId: "t" })] } })
    const next = apply(state, "turn", { phase: "start", agentId: "a" }).state
    expect(next.turnActive).toBe(true)
    expect(next.runningAgentId).toBe("a")
    expect(next.streaming).toEqual({})
    expect(next.liveActivity).toEqual({})
  })

  it("end clears the running/paused/pending state", () => {
    const state = baseState({ turnActive: true, runningAgentId: "a", paused: true, pausedQuestion: "?", pendingRoute: [] })
    const next = apply(state, "turn", { phase: "end" }).state
    expect(next).toMatchObject({ turnActive: false, runningAgentId: null, paused: false, pausedQuestion: null, pendingRoute: null })
  })

  it("pause sets paused state and emits a waiting notice", () => {
    const { state, effects } = apply(baseState({ turnActive: true }), "turn", { phase: "pause", question: "Which?", askerId: "a" })
    expect(state).toMatchObject({ turnActive: false, paused: true, pausedQuestion: "Which?", pausedAskerId: "a" })
    expect(effects).toEqual([{ type: "notice", msg: "a is waiting for your answer.", level: "info" }])
  })

  it("pause carries QCM options into pausedOptions; empty/missing become null", () => {
    const withOpts = apply(baseState(), "turn", { phase: "pause", question: "Q", askerId: "a", options: ["x", "y"] }).state
    expect(withOpts.pausedOptions).toEqual(["x", "y"])
    const without = apply(baseState(), "turn", { phase: "pause", question: "Q", askerId: "a" }).state
    expect(without.pausedOptions).toBeNull()
    const empty = apply(baseState(), "turn", { phase: "pause", question: "Q", askerId: "a", options: [] }).state
    expect(empty.pausedOptions).toBeNull()
  })

  it("end and resume both clear pausedOptions", () => {
    const pausedState = baseState({ paused: true, pausedQuestion: "Q", pausedAskerId: "a", pausedOptions: ["x"] })
    expect(apply(pausedState, "turn", { phase: "end" }).state.pausedOptions).toBeNull()
    expect(apply(pausedState, "turn", { phase: "resume", askerId: "a" }).state.pausedOptions).toBeNull()
  })

  it("resume clears the pause and re-activates with a notice", () => {
    const state = baseState({ paused: true, pausedQuestion: "?", pausedAskerId: "a" })
    const result = apply(state, "turn", { phase: "resume", askerId: "a" })
    expect(result.state).toMatchObject({ paused: false, pausedQuestion: null, turnActive: true })
    expect(result.effects[0].msg).toBe("Resuming — answering a")
  })

  it("chain emits a routing notice and leaves state untouched", () => {
    const state = baseState()
    const { state: next, effects } = apply(state, "turn", { phase: "chain", from: "planner", targets: ["coder", "qa"] })
    expect(next).toBe(state)
    expect(effects).toEqual([{ type: "notice", msg: "@planner → @coder @qa", level: "info" }])
  })
})

// ── settings / routing ───────────────────────────────────────────────────────

describe("reduce — settings & routing", () => {
  it("applies chaining and only the optional fields present in the payload", () => {
    const state = baseState({ chaining: true, maxChainHops: 30, allowCloud: false })
    const next = apply(state, "settings", { chaining: false, allowCloud: true }).state
    expect(next.chaining).toBe(false)
    expect(next.allowCloud).toBe(true)
    expect(next.maxChainHops).toBe(30) // untouched — absent from payload
  })

  it("a proposed route populates pendingRoute and stops the active turn", () => {
    const proposals = [{ from: "a", target: "b", targetName: "B" }]
    const next = apply(baseState({ turnActive: true }), "routing", { type: "proposed", proposals }).state
    expect(next.pendingRoute).toEqual(proposals)
    expect(next.turnActive).toBe(false)
  })

  it("a resolved route clears pendingRoute", () => {
    const state = baseState({ pendingRoute: [{ from: "a", target: "b", targetName: "B" }] })
    const next = apply(state, "routing", { type: "resolved" }).state
    expect(next.pendingRoute).toBeNull()
  })
})

// ── transcript / conversations / providers ───────────────────────────────────

describe("reduce — transcript, conversations, providers", () => {
  it("transcript replaces messages and clears all transient buffers", () => {
    const state = baseState({
      messages: [msg({ index: 0, author: "a" })],
      streaming: { a: "x" },
      receipts: { 0: { participantId: "a", created: [], modified: [], deleted: [] } },
    })
    const fresh = [msg({ index: 0, author: "user" })]
    const next = apply(state, "transcript", fresh).state
    expect(next.messages).toEqual(fresh)
    expect(next.streaming).toEqual({})
    expect(next.receipts).toEqual({})
  })

  it("conversations updates the list and current id", () => {
    const list = [{ id: "c1", title: "T", createdAt: 0, updatedAt: 0, messageCount: 2 }]
    const next = apply(baseState(), "conversations", { currentId: "c1", list }).state
    expect(next.currentConversationId).toBe("c1")
    expect(next.conversations).toEqual(list)
  })

  it("providers updates only the keys present in the payload", () => {
    const state = baseState({ explicitlyEnabled: ["anthropic"] })
    const providers = [{ name: "x", displayName: "X", configured: true, explicitlyEnabled: false, models: [] }]
    const next = apply(state, "providers", { providers }).state
    expect(next.providers).toEqual(providers)
    expect(next.explicitlyEnabled).toEqual(["anthropic"]) // untouched
  })
})

// ── oauth_progress ───────────────────────────────────────────────────────────

describe("reduce — oauth_progress", () => {
  it("device_code surfaces an info notice with the verification details", () => {
    const { effects } = apply(baseState(), "oauth_progress", {
      type: "device_code",
      provider: "github",
      verificationUri: "https://gh/login",
      userCode: "ABCD",
    })
    expect(effects[0].level).toBe("info")
    expect(effects[0].msg).toContain("ABCD")
    expect(effects[0].msg).toContain("https://gh/login")
  })

  it("error surfaces an error-level notice", () => {
    const { effects } = apply(baseState(), "oauth_progress", { type: "error", message: "denied" })
    expect(effects).toEqual([{ type: "notice", msg: "denied", level: "error" }])
  })

  it("persists the progress in state for a stay-on-screen panel", () => {
    const { state } = apply(baseState(), "oauth_progress", {
      type: "device_code",
      provider: "github",
      verificationUri: "https://gh/login",
      userCode: "ABCD",
    })
    expect(state.oauthProgress).toEqual({
      provider: "github",
      status: "device_code",
      verificationUri: "https://gh/login",
      userCode: "ABCD",
      url: undefined,
      instructions: undefined,
      message: undefined,
    })
  })

  it("carries the provider forward when a later event omits it", () => {
    const after = apply(baseState(), "oauth_progress", { type: "device_code", provider: "github", userCode: "X" }).state
    const { state } = apply(after, "oauth_progress", { type: "success", message: "done" })
    expect(state.oauthProgress?.provider).toBe("github")
    expect(state.oauthProgress?.status).toBe("success")
  })
})

// ── resetTransient ───────────────────────────────────────────────────────────

describe("resetTransient", () => {
  it("clears per-turn fields but preserves roster, messages and settings", () => {
    const state = baseState({
      roster: [rosterItem({ id: "a" })],
      messages: [msg({ index: 0, author: "a" })],
      chaining: false,
      turnActive: true,
      runningAgentId: "a",
      paused: true,
      streaming: { a: "x" },
      receipts: { 0: { participantId: "a", created: [], modified: [], deleted: [] } },
    })
    const next = resetTransient(state)
    expect(next.roster).toHaveLength(1)
    expect(next.messages).toHaveLength(1)
    expect(next.chaining).toBe(false)
    expect(next.turnActive).toBe(false)
    expect(next.runningAgentId).toBeNull()
    expect(next.paused).toBe(false)
    expect(next.streaming).toEqual({})
    expect(next.receipts).toEqual({})
  })
})
