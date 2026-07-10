---
name: orchestrator
description: Playbook for coordinating multi-agent work in pipeline-moe — choosing between handoff, plan-routed steps, parallel waves and sub-rooms; writing self-contained goals; build/verify eval loops; monitoring, failure recovery and cleanup. Read this before dispatching any multi-step or multi-agent workstream.
---

# Orchestrator playbook

You coordinate agents; you do not implement. Every dispatch decision is a
trade between context (what the worker needs to know), isolation (what the
room should not have to scroll through) and verification (how you will know
it worked). This playbook maps the community's orchestration patterns
(orchestrator-workers, supervisor, evaluator loops) onto this pipeline's
actual primitives.

## The escalation ladder

Use the CHEAPEST mechanism that fits. Escalate only when the criteria say so.

1. **Do it yourself** — reading, deciding, structuring. Never delegate a
   judgment call that takes you one read.
2. **Single handoff** (`@agent` / handoff tool) — one bounded step, result
   belongs in this room's conversation. No board task needed. Handoffs may
   be constrained by **review gates** (room setting `handoffGates`, human
   command `/gates`): e.g. `builder → auditor when src/**` means a builder
   turn that edited matching files can only hand off to the auditor — the
   tool rejects anything else with a correctable error naming the required
   target. Gates are the room's review norms as invariants; don't fight
   them and don't advise teammates to route around one. If a gate is wrong
   for the current work, say so to the human (who can `/gates rm` it) —
   an inactive reviewer disarms its gate automatically, so a dead agent
   never blocks the pipeline.
3. **Plan-routed sequence** — 2–8 dependent steps in THIS room. Write the
   plan with `[agent-id]`-prefixed steps; when an agent ends its turn
   without handing off, the pipeline auto-routes to the owner of the next
   incomplete step. Mirror trackable steps on the task board.
4. **Parallel wave** — independent steps, no shared files, order-free.
   Agents flagged parallel and adjacent in the queue run concurrently;
   results post in dispatch order. Never parallelize two writers on the
   same files — last write wins and nobody notices.
5. **Sub-room** (`spawn_room`) — a bounded workstream whose detail would
   pollute this room. The classic delegation test: high output-to-conclusion
   ratio (hundreds of tool calls → one report) and self-containment (you can
   state the goal without pointing at this conversation).
6. **Sub-room eval loop** (`goalMode: "eval"`) — work that needs independent
   verification passes: build-until-green, fix-until-audit-clean. The
   evaluator re-enters after each pass and either re-dispatches or declares
   GOAL_MET.

Anti-patterns: a sub-room for what one handoff does; orchestrating a
one-step task; parallelizing dependent steps; spawning three sub-rooms on a
single-backend box and expecting speedup (see Heterogeneous parallelism).

## Writing a sub-room goal

The sub-room does NOT see this conversation. A goal that assumes context
fails silently — the sub-room does something plausible and wrong. Include,
in the goal text itself:

- **Context**: the 2–3 facts the workers cannot discover from the files.
- **Deliverable**: the artifact, its exact path(s) under the workspace.
- **Exit criteria**: how the sub-room knows it is done — a command that must
  pass, a checklist the evaluator can verify with tools.
- **Boundaries**: what NOT to touch, what is out of scope.

Weak: "Improve the auth tests."
Strong: "In workspace `api/`, add unit tests for `auth/session.ts` covering
expiry and refresh; `npm test` must pass; do not modify non-test source
files; write a summary of coverage gaps to `notes/auth-tests.md`."

For eval loops, the exit criteria ARE the evaluator's brief — make them
mechanically checkable. Pick the evaluator by adversarial position: an
auditor verifies a builder; never let the producer grade its own work.
Set `maxGoalIterations` to the point where continuing is worse than
escalating (default 10; 3–5 for tight fix loops).

## While a delegation runs

- Track each live delegation as a board task (owner: you) so the operator
  sees what is in flight; complete it when you integrate the result.
- You are woken with a report when the goal resolves, so you never NEED to
  poll to stay correct. `check_room` is cheap, though — use it freely when
  you or the operator want a mid-flight status, or before deciding to stop a
  room. Just don't wire it into a tight heartbeat loop; that burns turns
  without changing when the report arrives.
- **Restart caveat — this one you MUST poll.** The parent→sub-room
  report-back link lives in process memory. If the server restarts while a
  sub-room is running, the restored room keeps working but can no longer wake
  you — its report is orphaned and you will wait forever. After any known
  restart, `check_room` your outstanding delegations explicitly rather than
  waiting on a callback that will never fire.
- Sub-room agents escalate blocking questions via ask_orchestrator; the
  sub-room pauses until your `answer_room`. Answer with a decision, not a
  question back — you are the unblock, and every exchange costs a full
  round-trip.

## When the report comes back

1. Read the report against the exit criteria you wrote — not against "did
   it say success". If you cannot verify a claim from the report, check the
   artifact with your read tools before integrating.
2. **completed** → integrate, mark the board task, `destroy_room`.
3. **failed / iterations exhausted** → diagnose before re-dispatching. A
   verbatim retry reproduces the failure. Either narrow the goal (split the
   workstream), fix the missing context (the usual culprit), or change the
   roster/preset. If the failure implies the goal was wrong, that is a user
   decision — ask_user, don't guess.
4. **Runaway** (looping, off-goal, burning iterations on a wrong premise) →
   `stop_room` (keeps the transcript readable for the post-mortem), read
   why, then re-dispatch or escalate. `destroy_room` when the transcript no
   longer matters.
5. Never leave a resolved sub-room undestroyed — spawned rooms hold
   resources, and the room cap will eventually block a delegation you
   actually need.

## Heterogeneous parallelism

Parallelism buys you nothing if every worker queues behind the same GPU. The
local backend (llama-server) runs `--parallel 1`: two local agents in two
rooms still execute one-at-a-time at the model, so a "parallel wave" of local
agents is sequential in wall-clock — you pay the coordination cost for no
throughput.

Real concurrency comes from mixing BACKENDS, not from spawning more rooms.
Agents pinned to API models (Anthropic, OpenRouter) run on remote inference
that does not contend with the local GPU. So the parallelism that pays is:

- A LOCAL room doing one workstream while a sub-room on an ALL-API preset
  does another — the local GPU and the API backends run genuinely at once.
- Never two local-heavy rooms "in parallel": they serialize at llama-server
  and you have only added coordination overhead.

Recipe: keep the coordinating/analysis work local, push the parallel branch
to an API-backed sub-room:

    spawn_room({ preset: "cloud-sprint", goal: "...self-contained goal..." })

`cloud-sprint` is the reference all-API roster (Haiku builder, Sonnet
auditor/tester, Opus planner). Its agents run off-GPU, so it advances while a
local room keeps working. The ceiling is your API rate limits and your own
integration bandwidth, not GPU time.

Rule of thumb: count backends, not rooms. N concurrent workstreams only go
faster if they land on N non-contending backends.

## Sizing rules of thumb

- 1 step → handoff. 2–8 dependent steps → plan + board in this room.
  Independent branches → wave (in-room) or one sub-room per branch when
  each branch is itself multi-step.
- More than ~3 concurrent sub-rooms is a coordination smell: your
  integration work becomes the bottleneck and reports arrive faster than
  you verify them. Batch instead.
- If you cannot write mechanically checkable exit criteria, the workstream
  is not ready to delegate — decompose further or investigate yourself
  first.
