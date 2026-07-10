// Supervised routing (phase 1) — the stateless decision runner and its
// route_decision tool.
//
// In `supervised` mode the room does not broadcast a pending handoff to human
// clients; it runs a SUPERVISOR DECISION instead: a throwaway, in-memory agent
// session on the supervisor persona's model, given a micro-context (the
// proposal set, a summary of the proposing turn, plan/board state) and exactly
// one tool. Stateless on purpose — a live-session decision would grow the most
// expensive context in the room on every hop, recreating the very problem
// supervised routing solves (design doc: docs/supervised-routing.md).
//
// Degradation is the load-bearing invariant: a dead supervisor must never
// deadlock the room. ANY non-decision outcome — thrown error, provider error,
// abort, timeout, or a turn that simply never calls route_decision — resolves
// to `decision: null` and the caller degrades that hop to auto with a notice.
// Same disarm principle as handoff gates.

import { Type } from "typebox"
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { installBatchTerminateGuard } from "./batch-terminate-guard.js"
import type { ResolvedModel } from "./model.js"

// ⚠ pi-coding-agent (and model.js, which pulls it) are loaded LAZILY inside
// runSupervisorDecision, not statically. room.ts imports this module, and a
// static import here would drag the whole pi-coding-agent package into every
// module graph that touches Room — measured: it doubled the test suite's
// import time (12.6s → 30s) and made timing-sensitive tests flaky under the
// added load. The tool builder below only needs typebox; only the runner
// (called on an actual supervised hop) needs the heavy machinery.

/** The supervisor's verdict on a proposal SET (pendingRoute.proposals is an
 *  array — parallel waves propose several handoffs; one decision covers all). */
export interface SupervisorVerdict {
  verdict: "accept" | "refuse" | "transfer"
  /** For 'transfer': the agent id(s) to dispatch instead of the proposals. */
  targetIds?: string[]
  /** Short rationale — surfaces in the transcript trace and, on refuse, is
   *  injected into the proposer's re-run. */
  reason: string
}

export interface SupervisorOutcome {
  /** null = degrade this hop to auto (dead-supervisor invariant). */
  decision: SupervisorVerdict | null
  /** When decision is null: human-readable cause for the degradation notice. */
  degraded?: string
}

const SUPERVISOR_SYSTEM_PROMPT = [
  "You are the routing supervisor of a multi-agent room. An agent just finished",
  "its turn and proposed one or more handoffs. Your ONLY job is to decide the",
  "fate of that proposal set by calling the `route_decision` tool exactly once.",
  "",
  "Verdicts:",
  "- accept   — the proposed handoff(s) dispatch as proposed.",
  "- transfer — dispatch to different agent(s) instead; provide `targetIds`.",
  "- refuse   — return the turn to the proposer with your reason; they will",
  "             re-run once with your reason injected and may propose differently.",
  "",
  "Judge against the provided plan/board state and the proposing turn: is this",
  "the right next seat for the work? Prefer accept unless the proposal clearly",
  "skips a required step, loops, or targets the wrong specialist.",
  "",
  "Call route_decision now, with a one-sentence reason. Do nothing else: no",
  "other output, no long analysis.",
].join("\n")

/** Build the route_decision tool. `capture` receives the first valid verdict;
 *  later calls are told the first one stands (and terminate, since there is
 *  nothing left for the supervisor turn to do). Exported for direct testing. */
export function createRouteDecisionToolDefinition(
  validTargetIds: string[],
  capture: (v: SupervisorVerdict) => void,
  peek: () => SupervisorVerdict | null,
): ToolDefinition<any, undefined> {
  const schema = Type.Object({
    verdict: Type.Union(
      [Type.Literal("accept"), Type.Literal("refuse"), Type.Literal("transfer")],
      { description: "accept = dispatch as proposed; refuse = return to sender with reason; transfer = dispatch to targetIds instead." },
    ),
    targetIds: Type.Optional(
      Type.Array(Type.String(), {
        description: `For transfer: agent id(s) to dispatch instead. Valid ids: ${validTargetIds.join(", ")}.`,
      }),
    ),
    reason: Type.String({ description: "One short sentence explaining the decision." }),
  })

  return {
    name: "route_decision",
    label: "Route decision",
    description:
      "Decide the fate of the pending handoff proposal set. Call exactly once: " +
      "accept (dispatch as proposed), refuse (return to the proposer with your reason), " +
      "or transfer (dispatch to `targetIds` instead).",
    parameters: schema,
    execute: async (_toolCallId: string, params: { verdict: "accept" | "refuse" | "transfer"; targetIds?: string[]; reason: string }) => {
      // One decision per proposal — the first call stands (same rule as double
      // handoff). Unlike the handoff error path this DOES terminate: a decision
      // is already captured, there is nothing to retry.
      const already = peek()
      if (already) {
        return {
          content: [{ type: "text", text: `route_decision error: you already decided (${already.verdict}) — the first call stands.` }],
          details: undefined,
          terminate: true,
        }
      }
      if (params.verdict === "transfer") {
        // De-dupe as well as validate (F1, audit): models repeat ids readily,
        // and the captured verdict feeds transcript traces + dispatch.
        const targets = [...new Set(params.targetIds ?? [])].filter((id) => validTargetIds.includes(id))
        if (targets.length === 0) {
          // Correctable error — no terminate, so the model retries in-turn
          // with valid ids (same recovery path as an invalid handoff target).
          return {
            content: [{
              type: "text",
              text:
                `route_decision error: transfer needs at least one valid targetId. ` +
                `Valid ids: ${validTargetIds.join(", ") || "none"}. Call route_decision again.`,
            }],
            details: undefined,
          }
        }
        capture({ verdict: "transfer", targetIds: targets, reason: params.reason })
      } else {
        capture({ verdict: params.verdict, reason: params.reason })
      }
      // terminate: true is load-bearing (F6) — without it the agent loop
      // re-invokes the model after the tool result and a chatty model keeps
      // deciding. The decision is made; the micro-turn is over.
      return {
        content: [{ type: "text", text: `Decision recorded: ${params.verdict}. Your turn ends now.` }],
        details: undefined,
        terminate: true,
      }
    },
  }
}

/** Run one stateless supervisor decision: ephemeral in-memory session on the
 *  supervisor persona's model, one prompt, one tool, disposed in all paths.
 *  Never throws — every failure mode collapses into `{ decision: null }`. */
export async function runSupervisorDecision(opts: {
  workspaceDir: string
  resolved: ResolvedModel
  allowCloud: boolean
  /** Supervisor persona's pinned model ("provider/id"); undefined → room default. */
  personaModel?: string
  /** Valid transfer targets — the active roster minus whoever must be excluded. */
  validTargetIds: string[]
  /** The micro-context: proposals, proposing-turn summary, plan/board state.
   *  Built by the caller (Room) — the runner is deliberately context-agnostic. */
  prompt: string
  /** Thinking level for the micro-turn. A route decision is bounded — default low. */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  /** Wall-clock cap before the hop degrades. Default 120s. */
  timeoutMs?: number
  /** Called once the ephemeral session exists, with a handle that aborts it.
   *  The room pulls this from abortCurrent(): a user Stop must not leave a
   *  ghost micro-turn deciding into the void — the internal timeout only
   *  covers the slow-supervisor case, not an external cancel. */
  registerAbort?: (abort: () => void) => void
}): Promise<SupervisorOutcome> {
  let decision: SupervisorVerdict | null = null
  const tool = createRouteDecisionToolDefinition(
    opts.validTargetIds,
    (v) => { decision = v },
    () => decision,
  )

  let session: AgentSession | null = null
  try {
    // Lazy imports — see the note at the top of this file.
    const [{ createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager }, { resolveModelRef }] =
      await Promise.all([import("@earendil-works/pi-coding-agent"), import("./model.js")])

    const loader = new DefaultResourceLoader({
      cwd: opts.workspaceDir,
      agentDir: getAgentDir(),
      // Replace pi's default prompt entirely — the micro-turn needs the
      // supervisor contract, not file-tool guidance for tools it doesn't have.
      appendSystemPromptOverride: () => [SUPERVISOR_SYSTEM_PROMPT],
    })
    await loader.reload()

    const model = resolveModelRef(opts.resolved, opts.allowCloud, opts.personaModel)
    const created = await createAgentSession({
      cwd: opts.workspaceDir,
      noTools: "builtin",
      customTools: [tool as ToolDefinition],
      thinkingLevel: opts.thinkingLevel ?? "low",
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(opts.workspaceDir),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      authStorage: opts.resolved.authStorage,
      modelRegistry: opts.resolved.modelRegistry,
      ...(model ? { model } : {}),
    })
    session = created.session
    session.setSessionName("route-supervisor")
    // Same batch-terminate class of bug as handoff (F6): if the model batches
    // route_decision with anything else, every result in the batch must carry
    // terminate for the loop to actually stop.
    installBatchTerminateGuard(session.agent)
    // Hand the caller a cancel handle (see registerAbort doc). Captured in a
    // local so the closure can't race the finally-path null-out of `session`.
    // Both sync throw and async rejection are swallowed (F3, audit): a Stop
    // landing in the window between our dispose() and the caller clearing its
    // handle would otherwise abort an already-disposed session — harmless in
    // intent, unhandled rejection in practice.
    const live = session
    opts.registerAbort?.(() => {
      try {
        void Promise.resolve(live.abort()).catch(() => { /* already disposed */ })
      } catch { /* already disposed */ }
    })

    // session.prompt() resolves even on abort/provider-error (stopReason is
    // tagged on the message instead) — so the timeout path aborts the session
    // and the race resolves through the same await.
    const timeoutMs = opts.timeoutMs ?? 120_000
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      void session?.abort()
    }, timeoutMs)
    try {
      await session.prompt(opts.prompt)
    } finally {
      clearTimeout(timer)
    }

    if (decision) return { decision }
    if (timedOut) return { decision: null, degraded: `supervisor decision timed out after ${Math.round(timeoutMs / 1000)}s` }
    // Provider error / abort / a turn that never called the tool — all the
    // same outcome for the room: no decision, degrade this hop. Walk the
    // messages backwards for an abnormal stop (same check as Participant's
    // extractAbnormalStop, on a throwaway session).
    const msgs = session.messages as Array<{ role: string; stopReason?: string; errorMessage?: string }>
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role !== "assistant") continue
      if (m.stopReason === "error") {
        return { decision: null, degraded: `supervisor turn failed${m.errorMessage ? `: ${m.errorMessage}` : ""}` }
      }
      break // most recent assistant message is a normal stop
    }
    return { decision: null, degraded: "supervisor ended its turn without calling route_decision" }
  } catch (err) {
    return { decision: null, degraded: `supervisor decision error: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    // The ephemeral session must not leak — dispose on every path.
    try { session?.dispose() } catch { /* already torn down */ }
  }
}
