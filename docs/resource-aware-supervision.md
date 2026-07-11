# Resource-aware supervision — the supervisor manages context, not just routes

> Idea: Dax, 2026-07-11 ("give the supervisor each agent's used context
> during supervised routing, and the ability to stop → compact builder →
> resume — the planner becomes a real orchestrator"). Sketch: Claude Fable 5
> (Claude Code). Status: design, not yet built.

## The idea in one line

Supervised routing made the planner a judge of WHERE work goes; this makes
it a manager of WHETHER the target can carry it. Two halves that only work
together: the supervisor SEES each seat's context pressure (information) and
can order a compaction before dispatch (actuator).

## Why the mechanics are almost free

The "stop → compact → resume" flow already exists structurally: a
supervised decision happens BETWEEN turns — the proposer just ended, the
target has not started, every seat is idle. The hop is already "stopped" by
construction. Compacting before dispatch needs no new state machine, no
mid-turn interruption, no pause type: it is one awaited step inserted in
`applySupervisorOutcome`, exactly where the dispatch already happens.
(Same discovery as supervised routing itself: the machinery exists,
pendingRoute then, the inter-turn gap now.)

## Design

### 1. Context pressure in the decision prompt (information)

`buildSupervisorPrompt`'s per-seat annotation gains the live number:

```
Active agents: planner (you — the supervisor),
  builder [claude-opus-4-8, cloud, ctx 72%],
  tester [Qwopus3.6-27B, local, ctx 31%]
```

Source: `Participant.getContextUsage()` — the same numbers the TUI bars
show. Render as a percentage (the raw token counts are noise at decision
time); omit the field when unknown (fresh seat, no turn yet). One line of
guidance joins the supervisor system prompt: high context on the TARGET of
a heavy handoff is a reason to compact first — not to refuse.

### 2. `compactIds` on the verdict (actuator)

`route_decision` gains an optional field:

```
route_decision({
  verdict: "accept" | "refuse" | "transfer",
  targetIds?: string[],     // transfer only
  compactIds?: string[],    // seats to compact BEFORE the dispatch
  reason: string,
})
```

Execution order in `applySupervisorOutcome`: compact (sequentially, each
awaited) → then dispatch the verdict. Rules:

- **Valid on accept and transfer.** On refuse it is still honored (the
  proposer being re-run may itself be the seat that needs the compaction —
  "your context is critical, I compacted you, now re-propose").
- **Validated like targetIds**: unknown/inactive ids dropped, de-duped
  (same F1 discipline — models repeat ids readily).
- **The supervisor may compact any active seat, itself included** — its
  live session is idle during the decision (the decision runs in the
  ephemeral session, not the live one).

### 3. Failure = hygiene, never liveness

Compaction is housekeeping; the dispatch is the room's forward progress.
A failed/erroring compaction on any seat: notice + **dispatch proceeds
anyway**. The compact step gets its own wall-clock cap (compaction is an
LLM summarization call — on a local backend it contends with the dispatch
itself; default cap ~120s per seat, same order as the decision timeout).
A user Stop during the compact step aborts it through the existing
supervisorAbort path and leaves the room consistent (the pendingRoute
identity guard already covers racing decisions).

### 4. Observability (the standing rule)

Every compaction ordered by the supervisor leaves a transcript trace:

```
🧹 @planner compacted @builder (ctx 91%) — reason
```

posted alongside the existing ✓/↪/✗ decision trace. The status bar already
shows `compacting` per seat (existing SSE status) — no client work needed
beyond what renders today.

## What this deliberately does NOT do

- **No proactive supervision loop.** The supervisor acts only at decision
  points (proposed handoffs). A background context-watcher would be a new
  autonomous actor — different feature, different risks (and auto-compaction
  already covers the emergency case at the reserve threshold).
- **No stop of RUNNING turns.** Mid-turn interruption for hygiene would
  trade forward progress for cleanliness — the inter-turn window is the
  right (and free) place.
- **No removal of auto-compaction.** The reserve-token safety net stays;
  supervisor compaction is the PROACTIVE layer above it (compact before a
  heavy dispatch, not when already choking).

## Measurement

Extend the T2 bench (workspace/shakedown/bench-route-decision.ts) — which
must FIRST be re-synced with the annotated prompt format (roster awareness
changed it; the 85% baseline predates annotations):

- new case category: context-pressure cases (target at ctx 9x% with heavy
  work proposed → expect compactIds on the verdict; target at 3x% → expect
  none — no compulsive compaction);
- re-baseline the whole battery with annotations + ctx fields present.

## Test surface

- verdict schema: compactIds validated/de-duped/dropped-if-unknown
  (mirror the targetIds F1 tests);
- applySupervisorOutcome: compact awaited before dispatch; failed compaction
  → notice + dispatch proceeds; user Stop during compact → clean abort,
  no orphan pendingRoute;
- prompt: ctx% present when known, absent when not;
- trace: 🧹 entry posted with the decision.

## Why it fits

The escalation ladder gave the planner judgment over WHAT to do; supervised
routing gave it judgment over WHERE work flows; this gives it judgment over
the ROOM'S RESOURCES — the three axes of an actual orchestrator, all
exercised at the same decision point, all observable, all degradable. And
the harness stays honest to the thesis: every new power arrives with the
information needed to use it well, in a form a local 27B can act on — a
percentage and a list, not a dashboard.
