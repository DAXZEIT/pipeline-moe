// Batch-terminate guard — closes the "turn-control tool batched with a normal
// tool" gap (knownissues.md). pi-agent-core only ends a turn early when EVERY
// finalized tool result in the batch sets terminate: true (agent-loop.js
// shouldTerminateToolBatch). A model that batches handoff/ask_orchestrator/
// ask_user with a normal tool (observed live: scout batched ls +
// ask_orchestrator) therefore gets another generation step, and a pathological
// small model that always batches could loop in-turn forever — the exact
// failure class the 3-9B target must never hit.
//
// The upstream extension seam can't fix this: pi-coding-agent's own
// afterToolCall wrapper (agent-session.js) drops the `terminate` field from
// extension hook results. So we wrap `session.agent.afterToolCall` directly
// (a public mutable property on pi-agent-core's Agent), chaining whatever
// handler pi-coding-agent installed: once ANY tool result in the current
// prompt/followUp run finalizes with terminate: true, every subsequent result
// is forced to terminate: true as well. Worst case is then bounded at ONE
// extra generation step (when the turn-control call was not first in its
// batch); the next batch — whatever it contains — terminates.

import type { AgentSession } from "@earendil-works/pi-coding-agent"

/** The session's underlying pi-agent-core Agent, via indexed access — the type
 *  is not exported from pi-coding-agent's public surface. */
type SessionAgent = AgentSession["agent"]

export interface BatchTerminateGuard {
  /** Clear the sticky flag. Call at the start of every prompt/followUp run —
   *  "turn" here means one whole Participant.run()/followUp(), which may span
   *  several model generation steps. */
  reset(): void
}

export function installBatchTerminateGuard(agent: SessionAgent): BatchTerminateGuard {
  const prev = agent.afterToolCall
  let terminateFired = false

  agent.afterToolCall = async (context, signal) => {
    // Chain the pre-existing handler (pi-coding-agent's extension runner)
    // first — its overrides win over the raw executed result, ours win last.
    const prevResult = prev ? await prev.call(agent, context, signal) : undefined
    const effectiveTerminate = prevResult?.terminate ?? context.result.terminate
    if (effectiveTerminate === true) {
      terminateFired = true
      return prevResult
    }
    // A turn-control tool already fired this run: force this result to
    // terminate too, so the batch satisfies the every()-check and the loop
    // stops re-invoking the model. Applies to error results as well — the
    // agent already gave its turn away; a failing sibling tool doesn't earn
    // it another generation step.
    if (terminateFired) {
      return { ...(prevResult ?? {}), terminate: true }
    }
    return prevResult
  }

  return {
    reset: () => {
      terminateFired = false
    },
  }
}
