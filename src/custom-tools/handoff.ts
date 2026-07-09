// handoff — pass the turn to another active agent via a single tool call
// instead of a free-text @mention. Closes F5: prose "@name" in an agent
// reply could not be distinguished from a quote or description of someone
// else's handoff (e.g. narrating "the auditor dispatched @tester"), so a
// careful agent quoting a transcript could trigger a spurious real handoff.
// The target is constrained to an enum of active agents (a menu, not free
// recall) so even a small (3-9B) model can use it reliably — it picks
// from a list instead of remembering handles and avoiding a character.
//
// Granted to every agent automatically (context-gated on a HandoffSink being
// present AND at least one other active agent existing) — NOT via the
// persona tool allowlist, so this can never hit the VALID_TOOLS drift class
// of bug (F0) that briefly made the orchestration tools ungrantable.
//
// No `message` argument on purpose (KISS): the calling agent already wrote
// its reasoning as normal reply text; the next agent reads the transcript.

import { Type } from "typebox"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { HandoffSink } from "../types.js"

export function createHandoffToolDefinition(sink: HandoffSink, personaId: string): ToolDefinition<any, undefined> {
  // Snapshot at build time (session creation) — this is the menu shown to the
  // model in the tool schema. Execution re-checks the LIVE roster via
  // sink.activeIds() again, so if the roster changed since this tool was
  // built (an agent kicked, deactivated, or never present), the call is
  // rejected with a correctable error rather than silently misrouting.
  const candidates = sink.activeIds().filter((id) => id !== personaId)

  // NOTE on typing: `candidates` is a runtime string[] (dynamic length, not a
  // tuple), so `Type.Union(candidates.map(Type.Literal))` produces a JSON
  // schema with the correct enum/anyOf of real candidate strings at runtime
  // (verified in tests), but TypeBox's Static<> can't extract literal types
  // from a non-tuple array — it collapses to `never`. Rather than fight that
  // through the generic, execute()'s params are hand-typed as `{ to: string }`
  // below, which is what they actually are at runtime; the real constraint is
  // enforced by the live-roster check inside execute().
  const schema = Type.Object({
    to: Type.Union(
      candidates.map((id) => Type.Literal(id)),
      { description: `The agent to hand your turn to. One of: ${candidates.join(", ")}.` },
    ),
  })

  return {
    name: "handoff",
    label: "Handoff",
    description:
      "Pass your turn to another agent in this room. Pick exactly one active agent id — " +
      "writing '@name' in your reply does NOT hand off anything anymore, only this tool call " +
      "does. If you don't call it, your turn ends and control returns to the human. Call it as " +
      "the last thing you do in your reply.",
    parameters: schema,
    execute: async (_toolCallId: string, params: { to: string }) => {
      // Live re-check, not the build-time snapshot: the roster may have
      // changed since this tool was constructed for this participant.
      const live = sink.activeIds().filter((id) => id !== personaId)
      if (!live.includes(params.to)) {
        return {
          content: [{
            type: "text",
            text:
              `handoff error: "${params.to}" is not a valid target right now (unknown, inactive, ` +
              `or yourself). Active agents you can hand off to: ${live.join(", ") || "none right now"}. ` +
              "Call handoff again with a valid id, or don't call it if the work is done.",
          }],
          details: undefined,
        }
      }
      sink.register(personaId, params.to)
      // terminate: true is load-bearing, not decorative (see F6). Without it,
      // "Your turn ends now" is advisory only — the underlying agent loop
      // (pi-agent-core's runLoop) re-invokes the model for another generation
      // step regardless, and a chatty model just keeps calling handoff again
      // (observed live: a 27B looped 13x, never actually dispatching). Setting
      // terminate: true on every finalized tool result in the batch is what
      // pi-agent-core checks to skip that re-invocation — mechanical, not
      // behavioral. Confirmed against the vendored agent-loop.js, not just
      // the .d.ts contract. Only the success path sets it: the error path
      // above deliberately does NOT, so the model gets to retry with a
      // corrected id in the same turn instead of being cut off mid-correction.
      return {
        content: [{ type: "text", text: `Handing off to @${params.to}. Your turn ends now.` }],
        details: undefined,
        terminate: true,
      }
    },
  }
}
