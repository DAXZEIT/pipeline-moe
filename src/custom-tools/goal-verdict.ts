// goal_verdict — the goal evaluator registers its MET / NOT-MET verdict as a
// structured tool call instead of a free-text magic token.
//
// Why: the eval loop used to rely solely on the evaluator writing the literal
// GOAL_MET token, parsed by Room.GOAL_MET_RE. Observed live (9B chaos-v2 run,
// 2026-07-12, room-mrh5o43l): the evaluator verified the goal correctly but
// answered with the eval prompt's bullet labels ("**MET**", five times in a
// row) — the regex never matched, six iterations burned, and the room failed
// closed over a correct workspace. A tool schema is a closed menu: a small
// (3-9B) model pattern-matches it reliably where it drifts on prose
// protocols — the exact reasoning behind the handoff enum (F5). The token
// path stays as a fallback for evaluator seats built before the goal named
// them (see index.ts grant note).
//
// Granted at build time to the room's evaluator seat ONLY — never to workers.
// Small models call any tool they are shown (cf. the scribe's spurious
// task_update the same day), so the menu is kept off their schemas entirely;
// execution still re-checks live state, so a stale grant degrades to a
// correctable error rather than silent goal state.

import { Type } from "typebox"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { GoalVerdictSink } from "../types.js"

export function createGoalVerdictToolDefinition(sink: GoalVerdictSink, personaId: string): ToolDefinition<any, undefined> {
  const schema = Type.Object({
    met: Type.Boolean({
      description:
        "true = you verified with your tools that the goal condition holds RIGHT NOW (this ends the room). " +
        "false = something is still missing or wrong.",
    }),
    reason: Type.String({
      description:
        "One or two sentences. met=true: what you verified and how. " +
        "met=false: precisely what is missing — the agent you dispatch next reads your reply for instructions.",
    }),
  })

  return {
    name: "goal_verdict",
    label: "Goal verdict",
    // Same rationale as handoff: pi runs a batch's tool calls in PARALLEL
    // unless a tool declares itself sequential. Two verdict calls in one
    // batch would otherwise race the first-call-stands guard (TOCTOU).
    executionMode: "sequential",
    description:
      "Register your verdict on the room goal. Call this exactly once per evaluation, AFTER verifying " +
      "the actual workspace state with your tools. met: true completes the goal and ends the room; " +
      "met: false records what is missing — follow it with handoff(to: ...) to dispatch the agent who " +
      "should close the gap.",
    parameters: schema,
    execute: async (_toolCallId: string, params: { met: boolean; reason: string }) => {
      // Live gate: the tool exists for the whole session, verdicts only mean
      // something while an eval-mode goal is running.
      if (!sink.goalEvalActive()) {
        return {
          content: [{
            type: "text",
            text:
              "goal_verdict error: no goal evaluation is in progress — this tool only applies while " +
              "you are evaluating the room goal. Continue normally.",
          }],
          details: undefined,
        }
      }
      // Build-time grant already targets the evaluator seat; re-check live in
      // case the goal was submitted with a different evaluator afterwards.
      if (sink.goalEvaluatorId() !== personaId) {
        return {
          content: [{
            type: "text",
            text:
              `goal_verdict error: @${sink.goalEvaluatorId()} is this room's goal evaluator, not you. ` +
              "Continue normally.",
          }],
          details: undefined,
        }
      }
      // One verdict per eval pass — first call stands (same contract as the
      // one-handoff-per-turn guard, and caught the same batching habit).
      const already = sink.peekVerdict?.()
      if (already) {
        return {
          content: [{
            type: "text",
            text:
              `goal_verdict error: you already registered ${already.met ? "met" : "not met"} this ` +
              "evaluation — one verdict per pass, the first call stands.",
          }],
          details: undefined,
        }
      }
      sink.registerVerdict(personaId, params.met, params.reason)
      if (params.met) {
        // terminate: true — a met verdict is the eval pass's final act, same
        // mechanics as handoff (without it the agent loop re-invokes the model
        // and a chatty evaluator keeps narrating after deciding).
        return {
          content: [{ type: "text", text: "Verdict registered: goal met. The goal completes now — your turn ends." }],
          details: undefined,
          terminate: true,
        }
      }
      // NOT met: no terminate — the evaluator should now dispatch the agent
      // who closes the gap (handoff), in this same turn.
      return {
        content: [{
          type: "text",
          text:
            "Verdict registered: goal NOT met. Now dispatch the agent who should close the gap: " +
            "call handoff(to: \"...\") — your reply text is their instructions.",
        }],
        details: undefined,
      }
    },
  }
}
