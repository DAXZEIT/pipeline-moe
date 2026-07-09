# Known Issues

## Open

### F7 — steer during provider retry crashes the turn
Steering `@planner` in the WebUI while the agent was mid-retry on a provider 529
(Opus overloaded) crashed the planner turn — the room showed empty `(no response)`
turns for each queued wake. Needs repro; likely steer-during-retry interplay,
unrelated to handoff. Observed 2026-07-09 ~05:18 (session mrcpe1pb).

### Stale-wake race (documented, wontfix for now)
A 📬 report enqueued by `stop_room` is still delivered after `destroy_room` — confirmed
systematic (2 occurrences). Benign while reports are informational only; becomes a real
TOCTOU if a consumer ever acts automatically on 📬 reports.

## Fixed

### `(no response)` shown for ask_user-only turns — fixed (2026-07-09)
A turn ending on `ask_user`/`ask_orchestrator` with no prose posted a literal
`(no response)` into the transcript above the 🤚 question callout. Root fix in
room.ts (`turnBody`): a question-only turn posts empty text — the callout IS the
body; a genuinely empty turn (incl. interrupted/failed, whose question is nulled)
keeps the placeholder and its partial marker. TUI/web skip the placeholder/bubble
when a question follows. Old persisted entries keep their literal text (back-compat).
Live-verified: planner QCM turn renders thought → tool call → 🤚 + options, no filler.

### Stale plan hijacked a conversational turn (planner→tester) — fixed (2026-07-09)
Planner replied to a direct user mention with no handoff; the room silently
dispatched to **tester**, who began restarting/killing backend processes. Root
cause: plan-aware fallback routing selected "the most-recently-modified
non-completed `.md`" in the shared `.pi/plans` graveyard (~50 never-closed
plans across all sessions). The winner was `6aa4e960` — tester's OWN validation
plan from a *different* session, step 1 `[tester] Restart the backend…` — and its
mtime kept getting re-bumped by tester's own `task_update`, making the hijack
self-reinforcing. The 6fecb34 workspace-scoping fix didn't cover this: the
default room legitimately points at that graveyard. Fix: **explicit adoption**
(room.ts `activePlanId` + plan-routing.ts `planAdoptionId`/`findPlanById`) — a
room routes ONLY by a plan its own agents actively worked this conversation
(create/claim/update); a read-only `plan list`/`get` never adopts, and with no
adopted plan the turn just ends. In-memory, reset on new goal / conversation
load, so no stale plan can ever drive routing. Regression test reproduces the
exact incident (read-only glance → tester untouched). 1028 tests green.

### Batch-terminate edge — turn-control tool batched with a normal tool — fixed (2026-07-09)
`terminate: true` only ends the turn if EVERY tool result in the batch sets it
(pi-agent-core agent-loop.js:345), so a model batching `handoff`/`ask_orchestrator`
with a normal tool got extra generation steps — a pathological small model could
loop in-turn. pi-coding-agent's extension seam drops `terminate`, so the fix wraps
`session.agent.afterToolCall` directly (src/batch-terminate-guard.ts): once any
tool result terminates, every later result in the run is forced to terminate too.
Worst case is now ONE extra generation step. Companion feature: one-shot
no-handoff menu in goal-eval rooms (room.ts proposeChain) — an agent ending its
turn without a handoff gets a single closed-menu re-prompt (valid handoff ids /
ask_orchestrator or ask_user / reply DONE), generated from live state.

### Work lost from the room on stop/abort — fixed in 1356a92 (2026-07-09)
Stopping a model mid-turn (or a turn dying on credit exhaustion / 5xx) discarded all
of the agent's work from the room while tool side-effects persisted. Now salvaged:
partial reply posted with `(interrupted — partial)` / `(failed — partial: <msg>)`
marker, inert for routing. Validated live (salvage-sanity room). Pipeline restarted
with the fix on 2026-07-09.

### No way to stop a turn from the TUI — fixed in 1356a92 (2026-07-09)
Esc on an empty line aborts the running turn (same POST /abort as the WebUI Stop
button), status-bar hint + /help updated. Live confirmation still pending: restart
the TUI, then Esc on empty line during a stream.

### Handoff/ask_orchestrator loop on chatty models — fixed in 39fec3c (2026-07-09)
Turn end was advisory; a 27B looped 13x on `handoff` and fired 3 duplicate
`ask_orchestrator` wakes. Both tools now set `terminate: true` on success —
mechanical turn end. Validated live: S2 re-run with Qwopus scout, single handoff,
single wake, GOAL_MET.
