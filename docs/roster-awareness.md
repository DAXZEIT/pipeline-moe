# Roster awareness — agents know who is in the room, and on what brain

> Idea: Dax, 2026-07-11 ("does the planner even see the roster? it should
> know who is in the room, with the underlying model"). Sketch: Claude
> Fable 5 (Claude Code). Built + live-verified 2026-07-11 (planner quoted
> its block verbatim from a real session; a deactivation delivered the
> roster_update to teammates with the fresh block).

## The gap (verified against the source)

Agents are roster-blind today. What an agent knows about its team:

- the candidate **ids** in the handoff tool's enum — a snapshot taken at
  session creation (`createHandoffToolDefinition`), names only;
- author names in the threaded transcript;
- one generic BASE_PROMPT sentence ("you are one of several specialized
  agents").

Nobody — the planner included — knows the **models** behind the seats, the
tool asymmetries (who can write, who is read-only), or vision capability.
Consequences, all observed:

- The planner cannot apply its own playbook: "count backends, not rooms"
  requires knowing which seats are local; delegating a hard refactor to the
  builder means something different when the builder is Opus 4.8 vs a local
  27B. Today it routes by role name and hopes.
- The supervisor judges transfers blind: `buildSupervisorPrompt` lists
  `Active agents: planner, builder, tester…` — ids only. A capability-aware
  verdict ("this is an architecture question → don't transfer it to a local
  seat") is impossible.
- An agent addressed to a read-only auditor with "please FIX src/x" cannot
  know the auditor physically can't (T2 bench case D2 passed on world
  knowledge of the ROLE, not on room facts).

## Design

Three insertion points, one shared formatter.

### 0. One formatter (pure)

`describeRoster(personas, resolvedDefault): string` — one line per ACTIVE
seat:

```
YOUR TEAM (roster at session start — updates arrive as roster_update notes):
- @planner (Planner) — anthropic/claude-fable-5 [cloud] — read-only + orchestration tools
- @builder (Builder) — anthropic/claude-opus-4-8 [cloud] — read/write/edit/bash
- @tester (Tester) — Qwopus3.6-27B [local GPU] — read/bash · vision
- @scribe (Scribe) — Qwopus3.6-27B [local GPU] — read/write/edit
```

Per seat: id, display name, resolved model (persona.model ?? room default)
with a `[local]`/`[cloud]` tag (the tag is what "count backends" needs — the
raw ref alone doesn't say it), a compact tool summary (write/bash presence,
read-only, web tools collapsed to "web"), vision flag. Deliberately NOT
included: system prompts (private per seat), skills (already surfaced to the
agent itself), costs (volatile; the local/cloud tag carries the decision-
relevant bit).

### 1. Roster block in the system prompt (birth)

`Participant.create` appends the block after ROOM_NOTE. The data is
reachable — the Room can pass the formatted block in (it already passes
workspaceDir, taskBoard, handoffSink…). A seat edited via PATCH is recreated
(existing behavior), so its OWN block is always fresh; staleness about
OTHERS is handled by (2).

### 2. `roster_update` on change (life)

Whenever the roster mutates — create / kick / activate / deactivate / a
persona's **model** change — the Room sends every OTHER active agent a
`sendCustomMessage({ customType: "roster_update", display: false,
deliverAs: "nextTurn" })` with the fresh block plus a one-line diff
("@auditor switched to anthropic/claude-opus-4-6"). Same channel and same
economy as work receipts: invisible in the transcript, lands before the
agent's next turn, costs nothing while nothing changes.

- **Batch mutations** (preset load / conversation load / reset) send ONE
  update after the batch, not seven — same debounce discipline as autosave.
- **Compaction caveat:** the block in the system prompt survives compaction;
  interim roster_update notes may not. On post-compact refresh (the room
  already refreshes agent memory there), re-send the current block — one
  message, worst case redundant.

### 3. Models in the supervisor micro-prompt

`buildSupervisorPrompt`'s roster line gains the same per-seat annotations:

```
Active agents: planner (you — the supervisor), builder [claude-opus-4-8, cloud], tester [Qwopus-27B, local]
```

This is measurable: re-run the T2 bench (workspace/shakedown/
bench-route-decision.ts) with capability-flavored cases (e.g. an
architecture question proposed toward a local seat with a frontier auditor
available) and compare transfer quality. The harness exists; the delta is
one evening.

## Costs and invariants

- **Context cost:** ~1 line per seat in the system prompt (paid once per
  session, cache-friendly — it sits in the stable prefix), plus one hidden
  message per actual roster change. No per-turn overhead.
- **Truthfulness:** the block must state RESOLVED models (after
  `resolveModelRef`), not raw persona fields — a persona with no pin shows
  the room default it will actually run.
- **No new privacy surface:** models were already visible to the human in
  every client; this only tells the agents what the operator already sees.
- **Do not couple to routing:** the block is informational. Handoff validity
  stays owned by the tool's live checks; gates stay owned by the registry.
  An agent reasoning from a stale block still gets the correctable error
  path — same recovery as today.

## Test surface

- formatter unit tests (pins, defaults, local/cloud tagging, read-only seat,
  vision, inactive seats excluded);
- Room integration: model PATCH on seat A → seat B's session received a
  roster_update (mock participant records custom messages — the receipts
  tests already model this);
- batch load → exactly one update per surviving agent;
- supervisor prompt snapshot includes annotations.

## Why it fits

The room already believes "observability before behavior" for humans — the
roster strip, the model row, the context bars. This extends the same
principle to the agents themselves: the planner should not have LESS
information about the team than the TUI header shows the operator. Same
facts, same source of truth, one formatter.
