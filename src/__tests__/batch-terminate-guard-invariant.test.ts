// Invariant test — pins the pi-side contract that batch-terminate-guard.ts
// depends on, against the REAL installed pi (pi-agent-core + pi-coding-agent),
// not a fake. batch-terminate-guard.test.ts proves the guard's own logic; this
// file proves the guard still means anything. It fails loudly if a pi bump
// breaks one of the three silent-regression scenarios:
//
//   1. `agent.afterToolCall` disappears or the run loop stops reading it
//      (Agent.createLoopConfig snapshots it per run). The guard would install
//      onto a dead property and rooms could loop in-turn forever.
//   2. `shouldTerminateToolBatch` (agent-loop.js) changes semantics — e.g.
//      every() becomes any() (gap silently closes on pi's side; the comment in
//      batch-terminate-guard.ts would be wrong and the guard redundant) — or
//      the loop stops honoring `terminate` at all (gap becomes infinite).
//   3. AgentSession's own afterToolCall wrapper (agent-session.js) stops
//      dropping `terminate` from the override object it returns. That drop is
//      documented in the guard's header as the reason the extension seam can't
//      fix the gap; if the wrapper starts passing `terminate` through (or stops
//      returning an override object), the guard's chaining assumptions change.
//
// Everything here is behavioral: a scripted StreamFn stands in for the model
// (counting generations — the exact resource an in-turn loop burns), and real
// pi classes (Agent, AgentSession) do everything else. No pi dist files are
// read. PI_OFFLINE is set by scratch-model.ts (imported below) before any
// ModelRuntime.create call, so nothing touches the network.

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core"
import { Agent } from "@earendil-works/pi-agent-core"
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, ToolCall, Usage } from "@earendil-works/pi-ai"
import * as piAi from "@earendil-works/pi-ai"
import type { AgentSession as AgentSessionType, LoadExtensionsResult, ResourceLoader } from "@earendil-works/pi-coding-agent"
import { AgentSession, createExtensionRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { installBatchTerminateGuard } from "../batch-terminate-guard.js"
import { scratchResolvedModel } from "./scratch-model.js"

// ---------------------------------------------------------------------------
// Scripted model + tools
// ---------------------------------------------------------------------------

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

// Never hits the network — the scripted StreamFn below intercepts every
// "provider" call before any transport is involved.
const FAKE_MODEL = {
  id: "scripted-model",
  name: "scripted-model",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "http://localhost:0",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as unknown as Model<Api>

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic" as Model<Api>["provider"],
    model: FAKE_MODEL.id,
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  }
}

const toolCall = (id: string, name: string): ToolCall => ({ type: "toolCall", id, name, arguments: {} })

// pi-ai's index re-exports AssistantMessageEventStream as type-only, but the
// class ships at runtime via `export * from "./utils/event-stream.js"` —
// bridge the two so the scripted model below uses pi's real stream class.
const AssistantMessageEventStream = (
  piAi as unknown as { AssistantMessageEventStream: new () => piAi.AssistantMessageEventStream }
).AssistantMessageEventStream

/** The pathological model the guard exists for: it emits the SAME tool-call
 *  batch in EVERY generation, forever. `generations` counts how often pi's run
 *  loop re-invoked the model — the signal every assertion below is built on.
 *  A safety cap ends the run after CAP generations even when nothing
 *  terminates, so a regression surfaces as `generations === CAP` instead of a
 *  hung test. */
const GENERATION_CAP = 4

function pathologicalModel(batch: ToolCall[]) {
  const state = { generations: 0 }
  const streamFn: StreamFn = (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => {
    state.generations += 1
    const stream = new AssistantMessageEventStream()
    const message =
      state.generations < GENERATION_CAP
        ? assistantMessage(batch)
        : assistantMessage([{ type: "text", text: "cap reached: the loop never terminated the batch" }])
    stream.push({ type: "done", reason: "stop", message })
    return stream
  }
  return { streamFn, state }
}

// Both tools are sequential so the loop finalizes each call in source order
// (executeToolCallsSequential) — the guard's per-result forcing then has a
// deterministic outcome. Under the default parallel strategy the afterToolCall
// finalizations race, which is exactly the live scout case: the guard still
// bounds that at one extra generation, but the count is timing-dependent.
const probeTool: AgentTool = {
  name: "probe",
  label: "probe",
  description: "normal tool — its result never carries terminate",
  parameters: Type.Object({}),
  executionMode: "sequential",
  execute: async () => ({ content: [{ type: "text", text: "probed" }], details: {} }),
}

const finishTool: AgentTool = {
  name: "finish",
  label: "finish",
  description: "turn-control tool — its executed result carries terminate: true",
  parameters: Type.Object({}),
  executionMode: "sequential",
  execute: async () => ({ content: [{ type: "text", text: "finished" }], details: {}, terminate: true }),
}

/** Wiring mirrors seat-runtime.ts: a fresh Agent, guard installed on
 *  `agent.afterToolCall` BEFORE the run starts (the loop snapshots the
 *  property per run in createLoopConfig). */
function makeAgent(streamFn: StreamFn, tools: AgentTool[]): Agent {
  return new Agent({
    streamFn,
    initialState: {
      systemPrompt: "batch-terminate invariant test",
      model: FAKE_MODEL,
      thinkingLevel: "low",
      tools,
    },
  })
}

// ---------------------------------------------------------------------------
// Couche 2a — the REAL pi-agent-core run loop (agent-loop.js) decides batch
// termination. These tests drive one full prompt() through it.
// ---------------------------------------------------------------------------

describe("pi run loop: pathological model always batching [probe, finish], NO guard", () => {
  test("the turn NEVER ends on its own — the every() gap is real and unbounded", async () => {
    const { streamFn, state } = pathologicalModel([toolCall("call-1", "probe"), toolCall("call-2", "finish")])
    const agent = makeAgent(streamFn, [probeTool, finishTool])

    await agent.prompt("go")

    // Every batch finalizes as [no-terminate, terminate], which fails the
    // every() check, so the loop keeps re-invoking the model until the safety
    // cap. If a pi bump changes every() to any(), batch 1 itself terminates
    // and this becomes 1 — the test fails, flagging that pi closed the gap
    // (the guard is then redundant and the guard header must be revisited).
    // If pi starts ignoring `terminate` entirely, the [finish]-only sanity
    // test below fails instead.
    expect(state.generations).toBe(GENERATION_CAP)
  })

  test("sanity: a batch of [finish] alone still terminates without the guard", async () => {
    const { streamFn, state } = pathologicalModel([toolCall("call-1", "finish")])
    const agent = makeAgent(streamFn, [probeTool, finishTool])

    await agent.prompt("go")

    // Pins that pi still honors terminate: true at all — without this, the
    // NO-guard test above would pass vacuously even if terminate handling
    // were ripped out of the loop entirely.
    expect(state.generations).toBe(1)
  })
})

describe("pi run loop: same pathological model WITH the guard on agent.afterToolCall", () => {
  test("[probe, finish]: bounded at ONE extra generation, then the turn ends", async () => {
    const { streamFn, state } = pathologicalModel([toolCall("call-1", "probe"), toolCall("call-2", "finish")])
    const agent = makeAgent(streamFn, [probeTool, finishTool])
    installBatchTerminateGuard(agent)

    await agent.prompt("go")

    // Batch 1 finalizes [probe (no terminate), finish (arms the guard)] — the
    // every() check fails before the flag existed, so one more generation is
    // unavoidable (the documented worst case in batch-terminate-guard.ts).
    // Batch 2: the sticky flag forces probe's result to terminate: true as
    // well, every() passes, the turn ends. If pi ever stops reading
    // agent.afterToolCall into the loop config (scenario 1), or
    // finalizeExecutedToolCall stops merging afterResult.terminate, or the
    // batch check starts ignoring terminate, this regresses to GENERATION_CAP
    // — the exact silent infinite-loop failure class the guard prevents.
    expect(state.generations).toBe(2)
  })

  test("[finish, probe]: the turn ends in the SAME generation", async () => {
    const { streamFn, state } = pathologicalModel([toolCall("call-1", "finish"), toolCall("call-2", "probe")])
    const agent = makeAgent(streamFn, [probeTool, finishTool])
    installBatchTerminateGuard(agent)

    await agent.prompt("go")

    // finish finalizes first and arms the flag; probe's result is forced to
    // terminate: true before the batch check runs; every() passes immediately.
    expect(state.generations).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Couche 2b — the REAL pi-coding-agent AgentSession: the guard chains the
// wrapper its constructor installs on agent.afterToolCall, and relies on that
// wrapper dropping `terminate` from the override it returns.
// ---------------------------------------------------------------------------

describe("AgentSession wiring", () => {
  let dir: string
  let session: AgentSessionType
  let rawAgent: Agent

  const emptyLoader = {
    getExtensions: (): LoadExtensionsResult => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  } as unknown as ResourceLoader

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pmoe-btg-inv-"))
    const settingsManager = SettingsManager.create(dir, join(dir, "agent"))
    const sessionManager = SessionManager.create(dir, join(dir, "sessions"))
    // PI_OFFLINE is set by scratch-model.ts at import time; the resolved
    // model here is only a placeholder for AgentSession's config.
    const { modelRuntime } = await scratchResolvedModel(dir)
    const { streamFn } = pathologicalModel([])
    rawAgent = makeAgent(streamFn, [])
    session = new AgentSession({
      agent: rawAgent,
      sessionManager,
      settingsManager,
      cwd: dir,
      modelRuntime,
      resourceLoader: emptyLoader,
      customTools: [],
    })
  }, 30_000)

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("session.agent.afterToolCall exists and is a function after construction", () => {
    // The guard's patch point: AgentSession's constructor installs its
    // extension-runner delegate as a plain mutable property on the Agent
    // (seat-runtime.ts installs the guard right after createAgentSession).
    // If a pi bump renames/removes it or installs it lazily instead, the
    // guard silently patches nothing — this fails first.
    expect(session.agent).toBe(rawAgent)
    expect(typeof session.agent.afterToolCall).toBe("function")
  })

  test("the AgentSession wrapper drops terminate from the override it returns", async () => {
    const ctx = {
      assistantMessage: assistantMessage([toolCall("call-1", "finish")]),
      toolCall: toolCall("call-1", "finish"),
      args: {},
      result: {
        content: [{ type: "text", text: "finished" }],
        details: {},
        terminate: true,
      },
      isError: false,
      context: { systemPrompt: "", messages: [], tools: [] },
    }
    const out = await session.agent.afterToolCall!(ctx as never)
    // The executed result's terminate must survive only via the loop's
    // `afterResult.terminate ?? result.terminate` fallback — the wrapper's own
    // return value must not carry it. If pi starts forwarding terminate here,
    // the extension seam could fix the gap and the guard's documented
    // rationale is stale; this fails so the comment gets revisited.
    expect(out?.terminate).not.toBe(true)
  })

  test("the guard chains on top of the REAL AgentSession wrapper", async () => {
    const guard = installBatchTerminateGuard(session.agent)
    const ctx = (terminate: boolean | undefined) => ({
      assistantMessage: assistantMessage([toolCall("call-1", "finish")]),
      toolCall: toolCall("call-1", "finish"),
      args: {},
      result: { content: [{ type: "text", text: "r" }], details: {}, terminate },
      isError: false,
      context: { systemPrompt: "", messages: [], tools: [] },
    })

    // Raw result carries terminate → guard arms; wrapper returned no
    // terminate, so the guard passes the wrapper's result through.
    await session.agent.afterToolCall!(ctx(true) as never)
    // Next result has NO terminate anywhere — but the sticky flag forces it.
    // This is the exact seat-runtime wiring: real wrapper chained, guard last.
    const forced = await session.agent.afterToolCall!(ctx(undefined) as never)
    expect(forced?.terminate).toBe(true)

    guard.reset()
    const afterReset = await session.agent.afterToolCall!(ctx(undefined) as never)
    expect(afterReset?.terminate).not.toBe(true)
  })
})
