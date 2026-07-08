# Plan-Aware Step Routing

> When an agent finishes a turn without @-mentioning anyone, the room can
> consult the active plan and route to the owner of the next incomplete step
> instead of the generic fallback agent. The plan becomes an executable
> contract — orchestration lives in the artifact, not in a planner turn.

---

## The `[owner]` convention

Prefix a plan step's text with its owner as `[agent-id]` (lowercase):

```json
{
  "id": 2,
  "text": "[builder] Wire the new endpoint into server.ts",
  "done": false
}
```

- The prefix must be lowercase, at the very start of the step text:
  `/^\[([a-z][a-z0-9_-]*)\]\s*/`.
- A step with no prefix is unowned — routing falls through to the room's
  generic fallback agent (default: `planner`), exactly as before this
  feature existed. All plans written before this feature have no prefix and
  keep working unchanged.
- Case matters: `[Builder]` does not match. A typo'd or wrong-case owner
  silently falls through to the generic fallback — it never errors or
  crashes the turn.

## What triggers it

Same trigger as the existing fallback routing: an agent finishes its turn,
`chaining` is on, `routingMode` is `auto`, and the reply contains no
`@mention`. At that point, with `planAwareRouting` enabled (default: on),
the room:

1. Finds the **active plan** — see selection rules below.
2. Reads its **first incomplete step** (`done: false`).
3. Parses an `[owner]` prefix from that step's text.
4. If the owner exists in the roster, is active, and isn't the agent who
   just finished (anti self-loop) — routes to it instead of the generic
   fallback agent.
5. Otherwise (no active plan, no prefix, owner missing/inactive/self) —
   falls through to the generic fallback agent, unchanged.

The routed agent receives a `plan_step_routing` custom message explaining
why it was called (as opposed to `routing_fallback` for the generic path),
so it knows to check the plan rather than guess from conversation context
alone.

## Active plan selection

Plan files live at `.pi/plans/*.md`. Despite the extension, they are **not**
pure JSON: each file is a JSON header (id, title, status, steps, etc.)
optionally followed by raw, unescaped markdown (`## Goal`, ...) when the
plan has a body. Parsing extracts only the JSON header (brace-depth scan,
respecting quoted strings) and ignores anything after it.

Selection does **not** filter on `status === "active"` — in practice that
field is set inconsistently (many long-shipped plans are still marked
`"active"` or `"draft"` because nobody called `plan update --status
completed` at closure). The only reliably-maintained signal is
`completed`/`archived`. So:

1. List `.pi/plans/*.md`.
2. Drop anything that isn't a valid plan file, or is `completed`/`archived`.
3. Among what's left, take the **most recently modified** (by file mtime) —
   this is the primary signal, not a tie-breaker.
4. Nothing left → no active plan, generic fallback applies.

A plan that's abandoned without ever being marked `completed`/`archived`
stays "eligible" indefinitely; if its mtime somehow becomes the most recent
again it could be picked up wrongly. Known, accepted limitation for v1 — in
practice the plan actually being worked is also the one most recently
touched.

## Suppressed during goal-eval

Sub-rooms running with `goalMode: "eval"` (see `docs/sub-rooms.md`) already
suppress the generic fallback agent for the whole goal run — the evaluator
is invoked deliberately after every drain, and any other automatic routing
would double-invoke it. Plan-aware routing is suppressed the same way, for
the same reason, restored when the eval loop ends (or the goal is aborted
mid-drain).

## Known limitation: bounded oscillation if a step is never marked done

If the owner of the active incomplete step never calls `complete-step` and
its reply also has no `@mention`, the anti-self-loop guard correctly blocks
it from being routed back to *itself* — but the turn then falls through to
the generic fallback agent (a different agent), which — if *its* reply also
has no mention — gets plan-aware-routed right back to the same owner. Two
individually-correct guards alternating: `owner → fallback → owner →
fallback`. This is bounded by `maxChainHops` (the one loop-protection
mechanism left after the circuit breaker's removal — see CHANGELOG
2026-07-08), not unbounded, but it can burn through the whole hop budget in
unproductive back-and-forth before stopping. Accepted for v1, consistent
with the project's post-circuit-breaker stance (bound by hop count, not
pattern detection) — worth knowing about if you see a room chew through its
chain budget with no forward progress: check whether the active plan's
current step owner is stuck without completing it.

## Toggle

`planAwareRouting` is a per-room boolean setting (default: on), plumbed the
same way as `fallbackAgent` — getter/setter on `Room`, included in
`GET`/`PATCH /api/settings` (and the room-scoped equivalent), persisted with
the conversation. No web UI in this pass — set it via the API or a future
TUI/web control if the need comes up.

## Multi-room caveat

Multiple rooms reading the same `.pi/plans/` directory could route off each
other's active plan — there's no per-room scoping of plan selection.
Accepted for v1 (current usage is a single primary room); worth revisiting
if multi-room becomes the common case.
