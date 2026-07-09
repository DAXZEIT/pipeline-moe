import { describe, expect, test } from "vitest"
import { installBatchTerminateGuard } from "../batch-terminate-guard.js"

// The guard wraps agent.afterToolCall (pi-agent-core Agent). These tests drive
// the wrapper exactly like agent-loop.js's finalizeExecutedToolCall does: one
// call per executed tool, merge semantics `afterResult.terminate ?? result.terminate`.

type AfterHook = (ctx: unknown, signal?: AbortSignal) => Promise<Record<string, unknown> | undefined>

function fakeAgent(prev?: AfterHook): { afterToolCall?: AfterHook } {
  return { afterToolCall: prev }
}

/** An AfterToolCallContext with just the fields the guard reads. */
const ctx = (terminate?: boolean) => ({ result: { content: [], terminate }, isError: false })

/** Mirror of the loop's merge: what `terminate` the batch check would see. */
const merged = (override: Record<string, unknown> | undefined, rawTerminate?: boolean) =>
  (override?.terminate as boolean | undefined) ?? rawTerminate

describe("installBatchTerminateGuard", () => {
  test("no override before any terminate fires", async () => {
    const agent = fakeAgent()
    installBatchTerminateGuard(agent as never)
    expect(await agent.afterToolCall!(ctx())).toBeUndefined()
    expect(await agent.afterToolCall!(ctx())).toBeUndefined()
  })

  test("forces terminate on every result after a terminating one", async () => {
    const agent = fakeAgent()
    installBatchTerminateGuard(agent as never)
    // Batch: [ls, handoff] — handoff last, so this batch won't terminate
    // (ls already finalized without it)…
    expect(merged(await agent.afterToolCall!(ctx()), undefined)).toBeUndefined()
    expect(merged(await agent.afterToolCall!(ctx(true)), true)).toBe(true)
    // …but the NEXT batch — whatever the model does — is forced to terminate.
    expect(merged(await agent.afterToolCall!(ctx()), undefined)).toBe(true)
    expect(merged(await agent.afterToolCall!(ctx()), undefined)).toBe(true)
  })

  test("handoff first in the batch terminates the same batch", async () => {
    const agent = fakeAgent()
    installBatchTerminateGuard(agent as never)
    // Batch: [handoff, ls] — both results end up terminate: true, so the
    // every()-check passes and there is no extra generation step at all.
    expect(merged(await agent.afterToolCall!(ctx(true)), true)).toBe(true)
    expect(merged(await agent.afterToolCall!(ctx()), undefined)).toBe(true)
  })

  test("reset() clears the sticky flag between runs", async () => {
    const agent = fakeAgent()
    const guard = installBatchTerminateGuard(agent as never)
    await agent.afterToolCall!(ctx(true))
    expect(merged(await agent.afterToolCall!(ctx()), undefined)).toBe(true)
    guard.reset()
    // New prompt/followUp run: normal tools no longer forced to terminate.
    expect(await agent.afterToolCall!(ctx())).toBeUndefined()
  })

  test("chains a pre-existing handler and preserves its overrides", async () => {
    const seen: unknown[] = []
    const prev: AfterHook = async (c) => {
      seen.push(c)
      return { content: [{ type: "text", text: "redacted" }] }
    }
    const agent = fakeAgent(prev)
    installBatchTerminateGuard(agent as never)

    // Pre-fire: prev's override passes through untouched.
    const before = await agent.afterToolCall!(ctx())
    expect(before).toEqual({ content: [{ type: "text", text: "redacted" }] })

    // Fire, then post-fire: prev's fields kept, terminate forced on top.
    await agent.afterToolCall!(ctx(true))
    const after = await agent.afterToolCall!(ctx())
    expect(after).toMatchObject({ content: [{ type: "text", text: "redacted" }], terminate: true })
    expect(seen).toHaveLength(3) // prev handler saw every call
  })

  test("a previous handler setting terminate also arms the guard", async () => {
    const prev: AfterHook = async () => ({ terminate: true })
    const agent = fakeAgent(prev)
    installBatchTerminateGuard(agent as never)
    await agent.afterToolCall!(ctx()) // raw result had no terminate; prev added it
    const next = await agent.afterToolCall!({ result: { content: [] }, isError: false })
    expect(merged(next, undefined)).toBe(true)
  })

  test("error results after the fire are terminated too", async () => {
    const agent = fakeAgent()
    installBatchTerminateGuard(agent as never)
    await agent.afterToolCall!(ctx(true))
    const errCtx = { result: { content: [{ type: "text", text: "boom" }] }, isError: true }
    expect(merged(await agent.afterToolCall!(errCtx), undefined)).toBe(true)
  })
})
