# Changelog

## [Unreleased] — 2026-07-11

### Added

- **Supervised routing (phase 1)** — new `routingMode: "supervised"` (additive; auto/
  semi/manual untouched): every handoff proposal is decided by the `supervisorAgent`
  (room setting, default `planner`) instead of dispatching freely or waiting on the
  human. The decision runs STATELESS in a disposable session on the supervisor's
  model (micro-context: proposals, proposer-turn summary, plan/board state) through a
  schema-constrained `route_decision({verdict: accept|refuse|transfer, targetIds?,
  reason})` — one decision per proposal SET (parallel waves propose several handoffs).
  Invariants wired: accept/transfer dispatch; refuse returns the turn to the proposer
  with the reason injected, bounded by an anti-ping-pong cap (same proposer→target
  after a refuse falls to the fallback); the supervisor's own proposals auto-accept;
  plan-owner routing is NOT supervised (the plan is the supervisor's own artifact);
  any non-decision outcome (error, interruption, no `route_decision` call, abort)
  degrades that hop to auto — a dead supervisor never blocks the room. Transcript
  traces `✓ / ↪ / ✗` + `routing` SSE events; clients (TUI ⇧⇥ cycle + `/route`, web
  buttons) learn the mode. Live-smoked on an isolated instance: first real decision
  ever was a motivated refuse, return-to-sender complied, abort mid-flow left no
  orphan `pendingRoute`. Design + retro: `docs/supervised-routing.md`.

### Fixed

- **One-handoff-per-turn guard was a TOCTOU race** — pi's agent loop executes a
  batch's tool calls in PARALLEL unless a tool declares `executionMode: "sequential"`;
  two `handoff` calls in one reply both passed the `peekHandoff` guard (both peek
  before either registers) and the second silently won. Observed live (session
  mrff3qwe entry 6: `handoff(tester)` + `handoff(auditor)`, both "ok", auditor got the
  turn while the builder's prose said "à toi @tester"). All four turn-control tools —
  `handoff`, `route_decision`, `ask_user`, `ask_orchestrator` — now declare
  `executionMode: "sequential"`; contract test pins the flag so the race can't return
  silently.

- **Fallback/plan-routing notice now states the dispatch order** — "No handoff
  detected — routing to @planner" fired while an earlier wave still had agents queued
  ahead, so the NEXT visible turn (e.g. @tester from a multi-mention user message)
  looked like it came out of nowhere. The notice now appends `(queued after @…)`
  when the routed agent lands behind existing queue entries.

- **Routing preview in both composers** — resolves the user-side F5: pasting a
  transcript or report containing `@builder`-style strings routes those agents
  (session mrff3qwe: a pasted smoke report containing `✗ @builder → @tester
  refused` queued both). Decision: observability over semantics — mention
  parsing is deliberately unchanged; instead the draft's ACTUAL routing is shown
  before send. New `previewRouting()` in client-core (exact mirror of the
  server's `resolveTargets` rules: same regex, `@all` fan-out, insertion order,
  unknown/inactive dropped — kept in lockstep, with the incident itself as a
  test case). TUI: the StatusBar gains a `⏎⇒ @builder @tester (ignored: @ghost)`
  segment while the draft mentions agents — a stable row, not a new one (the
  transcript height math is untouched). WebUI: a `route-preview` chip above the
  composer row with roster icons/colors. Default routing stays silent — no
  noise on the common case.

## [Unreleased] — 2026-07-10

### Added

- **Handoff review gates** — new declarative room setting `handoffGates`
  (`{from, via, when?}`): while `from` has touched files matching the `when` globs
  during its current turn, its handoff MUST target `via`. Enforced inside the handoff
  tool as a correctable error (no terminate), so the model re-routes itself in the
  same turn — the review norm ("everything under `src/` passes through the auditor")
  is now a core invariant instead of prose. A gate whose `via` is absent/inactive is
  skipped (a 403'd reviewer must not deadlock the room). Pure logic in
  `src/handoff-gates.ts` (own glob matcher, no new dependency); wiring: Room setting +
  conversation persistence + `PATCH /api/settings` + preset field (save/load/apply) +
  TUI `/gates` command (`/gates`, `/gates add <from> <via> [glob ...]`, `/gates rm <n>`,
  `/gates clear`). All shipped presets with an auditor now carry
  `builder→auditor when src/**` by default. Known limit: paths changed as a side
  effect of `bash` don't arm a gate (same blind spot as activity-based receipts).

- **Handoffs are now visible in the transcript** — the source message carries
  `handoffTo` (persisted, stamped by the Room before consumption); the TUI renders
  a dim `↪ handoff → @scribe` footer under the reply, and the webUI renders the same
  line with the target's icon and color. Root cause of the "the turn feels random"
  report (session mre5zpel): tester silently called `handoff(to:"scribe")` twice with
  no prose announcement, and nothing in any client showed tool-only handoffs.

- **Orchestrator playbook: review gates** — the escalation ladder's handoff entry now
  documents `handoffGates`/`/gates` so a planner knows the invariant exists, doesn't
  advise routing around it, and escalates to the human when a gate is wrong.

- **`live-verify` skill for auditor + tester** — replaces "dead documentation" (the
  global pi tmux cheat sheet is a HUMAN reference: prefix keybindings an agent can't
  press, and a description that never matches the moment of need). The new skill is a
  procedural playbook written for agents: rule zero (never touch the production
  instance — kill only your own PIDs, no pattern pkill), Pattern A isolated backend
  (scratch PORT/WORKSPACE_DIR, curl the claim end-to-end including error paths, read
  the session JSON on disk), Pattern B tmux-driven TUI (launch as the pane command,
  never through an interactive shell; send-keys text and Enter as TWO separate calls —
  Ink misses key.return otherwise; capture-pane output pasted verbatim as the receipt),
  Pattern C full loop. Granted via seed `skills` on auditor + tester — every preset
  without an explicit skills override inherits it automatically (strip/rehydrate).
  Trigger lines added to both role overlays: tester ("green tests are NOT the finish
  line for a runtime claim"), auditor ("a runtime claim cannot be closed from code
  reading alone" — read-only auditors prescribe the exact scenario to the tester).

### Changed (webUI)

- **Routing approval card redesigned** — proposals now render as roster-identity chips
  (icon + name in the agent's color, pill-shaped `from → target`) instead of bare
  `@id → @id` text; header reads "Handoff awaiting approval" with a ⏸ marker; the
  redirect picker autofocuses and no longer offers the proposer as a target (handing
  the turn back to whoever just ended it is what Drop already does).

### Fixed

- **Double handoff in one turn** — a model batching two `handoff` calls in a single
  reply had the second silently overwrite the first (observed live turn 27: two
  `handoff(to:"tester")`, both "ok"). The tool now rejects the second call with
  "already handed off to @x this turn — the first call stands" via the new
  `peekHandoff` on HandoffSink.

- **Stale handoff registrations** — an interrupted/failed turn, or a turn in manual
  routing mode, left its `handoff` registration pending forever (nothing consumed it),
  so it would silently fire on that agent's NEXT turn — and, with the double-call
  guard, would have blocked all future handoffs. The drain loop now discards the
  registration in both cases.

### Changed

- **Orchestrator skill relaxed** — `check_room` is cheap, polling by curiosity is OK.
  Only tight heartbeats remain forbidden. A restart note documents that restored sub-rooms
  lose their report-back link (`restoreRooms()` never repasses `parentLink`; the manifest
  serializes only roomId/name/workspaceDir/sshTarget) — `check_room` is mandatory after
  a restart. New section on heterogeneous parallelism: real parallelism requires mixing
  backends (local serializes behind `--parallel 1`), with a concrete recipe using
  `spawn_room({preset: "cloud-sprint"})` for an off-GPU branch while a local room works.

- **Preset personas now inherit `skills` from SEED automatically** — a new pure module
  `src/preset-hydration.ts` extracts `stripSeedFields` + `rehydrateSeedFields` from
  `server.ts`. Semantics mirror what already existed for `systemPrompt`: a field ABSENT
  from the preset means "not specified" → inherit the current seed value, so a preset
  saved before a capability existed picks it up automatically. A field PRESENT — even
  empty (`skills: []`) — is an explicit override. `tools` are deliberately NOT inherited:
  presets specify tools explicitly and intentionally diverge from the seed (e.g. a planner
  granted write/edit for in-room file work), and silent inheritance could not fix a
  present-but-incomplete list anyway. 9 new tests, including an integration test proving
  every shipped preset loads with the planner carrying `["orchestrator"]`.

- **Orchestration tools added to top-level planner personas in shipped presets** —
  `spawn_room`, `check_room`, `stop_room`, `destroy_room`, `answer_room` added to the
  planner in 9 presets: mainmix, cloud-main, main, 2106BUILD, CHEAPBUILD, FREEROOM,
  local-default, Versa, relay-local. Two presets intentionally left without orchestration
  tools: `cloud-sprint` (planner = parallel worker, coordinates in-room by handoff, does
  not nest-spawn) and `planning-room` (single planner, already a sub-room). The drift was
  structural: each new persona capability had to be manually propagated to every preset.

- **`skills` strip is now conditional (strip-si-identique)** — auditor found that the
  original implementation (keep `skills` on save, inherit only when absent on load)
  self-healed a pre-feature preset once, then re-froze it: after one save cycle, the
  `skills` field was present on disk, so a future SEED skill addition would not be
  inherited. Fix: `stripSeedFields` (renamed from `stripSeedPrompts`) now strips
  `skills` only when it matches the SEED's current skills — non-modified personas stay
  absent on disk and inherit continuously (permanent anti-drift like `systemPrompt`);
  customized personas (including opt-out `[]`) differ from SEED and are preserved.
  Functions are injectable (`seedPersonas` parameter) for testing the exact auditor
  scenario (v1→v2, seed gains a skill, reload picks up both). Regression guard test
  proves the old "keep-always" behavior would miss the new skill.

- **Phantom tests replaced with real imports** — `presets.test.ts` and
  `presets-fixes.test.ts` previously re-implemented `stripSeedPrompts`/`rehydratePrompts`
  logic inline (testing a copy, not the source). They now import and call the real
  `stripSeedFields`/`rehydrateSeedFields` from `preset-hydration.ts`. Shape-guard
  invariants retained with a NOTE pointing to `preset-hydration.test.ts` for behavioral
  coverage. Net: ~166 lines removed from `presets.test.ts`.

- **TUI header divider** — new `HeaderDivider` component: a dim, full-width rule
  separating the header area (tabs + roster + tasks) from the conversation. Always-on,
  budgeted in `reservedRows` (without this, the `rows-8` height budget overflows and
  Ink corrupts the layout — the bug "── You ── disappeared" that comments document).

- **TUI conversation title** — the current conversation title now appears on the RoomTabs
  line (same line as room tabs, zero vertical cost): `· 💬 <titre>`. Title sourced from
  `state.conversations` via `currentConversationId` — same data as the webUI's
  `ConversationBar`. Title truncated to 28 chars with ellipsis to stay on one line;
  fallback `—` when no title. `reservedRows` untouched. Note: `RoomTabs` has
  `flexWrap="wrap"` and isn't counted in `reservedRows` — with many rooms + a long title,
  the line can wrap (pre-existing risk, not introduced by this change).

### Fixed

- **Sub-room planners now have the orchestrator skill** — previously the skill was wired
  in `personas.ts` but presets saved before the feature never received it because the
  `skills` field was missing. The `rehydrateSeedFields` mechanism (which already handled
  `systemPrompt`) now covers `skills` too, so this class of drift cannot recur.

### Known issues

- **`systemPrompt` data-loss vector** (narrow, documented) — `systemPrompt` is editable
  by agents (PATCH `server.ts:1043/1719`), so a seed persona with a customized prompt
  loses that customization on a save/reload cycle (the unconditional strip drops any
  `systemPrompt`, not just seed-identical ones). Passing to strip-si-identique like
  `skills` would be a semantic product decision (snapshot vs reference) that overlaps
  with ROADMAP #6 (`promptFrom`/template-alias). Documented as a NOTE in
  `preset-hydration.ts` JSDoc; deferred to ROADMAP #6.

- **cloud-sprint builder2 has a stale systemPrompt** teaching the obsolete `@name` handoff
  mechanism (today only the `handoff` tool routes). Fixing it by hardcoding a new prompt
  would perpetuate the drift this PR fights; the proper fix is a `promptFrom`/template-alias
  mechanism (ROADMAP debt). 2 pre-existing test flakes unrelated to these changes:
  `room-goals.test.ts` (ENOTEMPTY teardown race under parallel execution) and
  `local-model-lock.test.ts` (intermittent). Both pass in isolation.

### Added

- **Closed orchestration loop — sub-rooms report back** (dax's request, 2026-07-09). spawn_room
  is no longer fire-and-forget: the spawner (room + agent) is recorded, and when the sub-room's
  goal resolves (completed / failed / cancelled) an "Orchestrator" report is injected into the
  parent room — transcript tail included — and triggers the spawner's turn there (passively
  posted if the parent is paused). New `ask_orchestrator` tool in every spawned sub-room:
  escalate a blocking question to the spawner and PAUSE the sub-room exactly like ask_user
  (works inside goal-eval loops — `runGoalEval` now honors a paused drain instead of clobbering
  it, keeping fallback suppression across the pause; this also fixes plain ask_user in eval
  goals). New `answer_room` orchestration tool for the spawner: the answer resumes the paused
  asker directly. The build/verify loop dax described is now: `spawn_room({goal, goalMode:
  "eval", goalEvaluator: "auditor"})` → builder↔auditor iterate → GOAL_MET → the planner wakes
  up with the report. All goal resolutions funnel through a single `resolveGoal()` so the
  callback can't be missed. Note: parent links live in memory — after a server restart a
  restored sub-room no longer reports back (check_room still works).

- **Shared task board — the planner becomes an orchestrator** (dax's request, 2026-07-09).
  Every agent gets three new tools whenever the room has a board (not gated on the persona
  allowlist, so personas saved before this feature receive them too): `task_create` (subject +
  optional owner), `task_update` (in_progress / completed / reword / reassign / delete) and
  `task_list`. The board is room-scoped, persisted in the conversation JSON (`tasks` field,
  absent = empty for older saves), broadcast over a new `tasks` SSE event and served by
  `GET /api/tasks` (+ room-scoped variant). The PLANNER_OVERLAY makes the planner the board's
  owner (decompose on dispatch, keep it truthful); BASE_PROMPT tells every agent to mark its
  own tasks in_progress when starting and completed only when verified. UI: TUI shows a
  compact "TASKS n/m" summary under the roster (current in-flight tasks) plus a full board
  overlay on **Ctrl+P** / `/tasks` (in-progress ▶ first, pending ☐, completed ✔ struck
  through, owners in agent colors); the web sidebar gets the same board as a panel. Plans
  (.pi/plans) are untouched and remain the engineering contract + routing source — the board
  is the live, user-visible orchestration layer on top.

### Fixed

- **Status bar now follows the agent actually generating** (PLAN-ea321024, bug 1) — `turn start`
  only carries the turn's first agent, so a chained drain (planner→builder→…) showed
  "running Planner" the whole way through. The server now emits `turn {phase:"agent", agentId}`
  every time an agent really starts (never per token); client-core updates `runningAgentId` on
  it, and both TUI and web inherit the fix. `turn start/end` semantics are unchanged.
- **Compact works during an ask_user pause** (bug 2a) — the compact guards (both HTTP endpoints
  and the `/compact` slash command) now use the new `Room.isGenerating()` (running or queued
  work only) instead of `isBusy()`, which also counts a pending question. A paused room is
  quiescent — that's precisely when compacting is safe and useful. Every other guard keeps
  strict `isBusy()`: mutating the room while it holds a frozen queue stays forbidden.
- **Paused state is displayed honestly** (bug 2b) — during an ask_user pause the TUI status bar
  shows "⏸ paused — waiting for your answer to @agent" instead of "idle", and the web topbar
  says the same instead of "ready". The "idle" lie is what made bug 2a's 409 read as a
  corrupted state.
- **Resume ordering is visible and favors recent intent** (bug 3) — when a pause resumes with
  held work, a notice announces the exact execution order ("Resuming: @builder, then @scribe
  (held)"); and a fresh @mention in the asker's post-resume reply now runs BEFORE the held
  queue (it used to be silently appended after, which read as a routing bug). Client-core also
  stops rendering unknown turn phases through the chain-notice path (`@undefined → …` on
  parallel waves) — unknown phases are now silently ignored, so older clients survive newer
  servers.

### Added

- **Planner behavioral amplification** (PLAN-d5661224) — `PLANNER_OVERLAY` gains two blocks,
  text validated by dax: *before* any plan, gate the goal ("is this worth solving, or a symptom?"
  — "delete it" is a valid plan) and present 2-3 candidate paths with tradeoffs and confidence
  for non-trivial work; *at* closure, append a `# Retro` section to the plan body (predictions
  vs reality) and pour follow-ups into `ROADMAP.md`, which the planner explicitly owns.

- **Plan-aware step routing** — when an agent finishes without @-mentioning anyone, the room
  now consults the active plan before falling back to the generic fallback agent: if the next
  incomplete step is prefixed `[agent-id]`, routing goes to that owner instead. Unprefixed steps
  (all plans written before this feature) behave exactly as before. New per-room
  `planAwareRouting` setting (default on), same plumbing as `fallbackAgent`. Suppressed during
  goal-eval runs for the same reason the generic fallback is. See `docs/plan-aware-routing.md`
  for the full contract, including a known limitation: if a step's owner never marks it done, a
  bounded owner↔fallback oscillation can occur, capped by `maxChainHops` (not a true loop, but
  worth knowing about). `src/plan-routing.ts` is a zero-Room-dependency pure module; ground-truth
  contract for the `.pi/plans/*.md` file format (JSON header + optional raw markdown body,
  despite the `.md` extension) is documented in its header comment. 47 new tests.

### Removed

- **Circuit breaker (repetition + tool-loop detection)** — removed entirely, including the
  per-room toggle, `PIPELINE_CIRCUIT_BREAKER` env var, the `circuit_breaker` SSE event, and the
  fallback recovery routing that ran when it tripped (`circuit_breaker_recovery`). In practice it
  missed real loops from local models (the failure mode it was built for) while doing nothing
  useful against frontier models, which don't loop the same way. The other anti-loop mechanisms
  — configurable max chain hops and planner-as-fallback-router — are unaffected and remain the
  active safety nets. `git revert` is the way back if this needs to return for a specific
  deployment.

## [Unreleased] — 2026-06-22

### Added

- **Multi-room system** — the pipeline hosts multiple independent rooms, each with its own
  roster, transcript, conversation store, and workspace scope. `RoomManager` coordinates them;
  rooms persist in `sessions/rooms.json` (atomic write-tmp+rename) and are restored on startup.
  UI: room tabs, create/rename, per-room SSE event filtering (no cross-room leaks). Room-scoped
  REST under `/api/rooms/:roomId/*`; the legacy `/api/*` routes are preserved (default room).
- **Per-room workspace scoping** — a room can be confined to a local path or a remote
  `user@host:/path` mounted via sshfs (auto-mount on create, auto-unmount on destroy/shutdown).
  Degraded restore when the remote is down: falls back to the pipeline workspace but keeps the
  intended target so it survives the next restart.
- **Sub-room orchestration** — the planner can spawn parallel sub-rooms with their own goal via
  the `spawn_room` / `check_room` / `destroy_room` tools (context-gated on a live orchestrator,
  so only the planner gets them). A sub-room does not share the parent conversation — its goal
  must be self-contained.
- **Goal-eval loop** — sub-rooms spawned with `goalMode: "eval"` use planner-as-evaluator: after
  each pipeline drain the evaluator re-enters, verifies the goal with its tools, and either
  dispatches more work (`@mention`) or declares `GOAL_MET`. Bounded by `maxGoalIterations`.
  Fallback routing is suppressed during eval to avoid double-invocation of the evaluator.
- **Sub-room stop control** — new `stop_room` tool + `orchestrator.stopRoom`: halt a runaway
  sub-room WITHOUT destroying it (cancels the goal → new terminal status `cancelled`, keeps the
  transcript for inspection). HTTP equivalent: `POST /api/rooms/:id/abort`. `PIPELINE_MAX_ROOMS`
  cap (default 8, enforced in `provisionRoom` for both entry points, `429` past the cap) prevents
  unbounded spawning from starving the single llama-server slot.
- **Multi-provider runtime auth** — add/remove provider API keys at runtime (`/provider` slash
  command + Providers panel) and apply presets in place.
- **Semi-automatic routing — backend** — in `semi` mode an agent's proposed `@mention` handoff no
  longer dispatches immediately: the wave's handoffs pause as a `pendingRoute` and emit a `routing`
  SSE event for approval. `POST /api/route` (and the room-scoped `/route`) resolves it — `approve`
  runs the proposed agent(s), `redirect` swaps in different ones (`targetIds`), `drop` continues
  with whatever was already queued. The no-handoff fallback stays automatic; proposals are
  de-duped per wave. The web UI adds a routing-mode selector (auto/semi/manual) and an approval
  card above the composer (✓ approve · ↪ redirect to another agent · ✕ drop). `manual` is
  selectable but currently behaves like `semi` (per-wave) — per-proposition granularity lands next.
- **Routing-mode setting (groundwork)** — `routingMode: 'auto' | 'semi' | 'manual'` per room,
  exposed via `GET`/`PATCH /api/settings` (and the room-scoped equivalent) and persisted per
  discussion. `auto` is today's behavior; the legacy `chaining` boolean is now *derived* from it
  (auto/semi → on, manual → off), and older saved conversations derive their mode from `chaining`
  on load. `semi` (human-approved handoffs) is plumbed but not yet active — the pause/approve flow
  lands in the next change.
- **Add agent from a template** — the roster's “+ New agent” is now “+ Add agent”: pick a
  built-in persona (e.g. a second Builder) to clone into the room with a unique id
  (`builder` → `builder-2`), keeping its tools, prompt, icon, and model — falling back to the
  room default if that model is unavailable. No more loading a whole preset and pruning it. A
  “Custom agent…” entry still opens the from-scratch form. New `GET /api/persona-templates` +
  `POST …/participants/from-template` (clones server-side, so long system prompts aren't
  round-tripped and the unique id / model validation happen in one place).
- **Room tab Stop button + status badges** — each room tab shows a live goal-status dot + label
  (running / done / failed / **stopped**) and, while a goal is running, a ⏹ Stop button that
  cancels it (`POST /api/rooms/:id/abort`) without destroying the room. The `created` SSE event
  now carries `goalStatus`, so the badge is correct from the moment a room appears.
- **Right-side panel tabs (Workspace | Presets)** — the previously workspace-only right panel is
  now tabbed. The **Presets** tab is a detailed roster browser: each preset expands to show its
  members (icon, name, model, thinking level, parallel flag, tool chips) with Load / Apply
  actions. No backend change — it reads the personas already returned by `GET /api/presets`. The
  compact 🎯 menu stays for quick save/delete.
- **Resume closed rooms** — a room's conversation data survives `destroy_room` / closing its tab
  (it was already on disk, just unreachable). Each room now writes a durable
  `sessions/<id>/meta.json` (name + workspace scope) that outlives the manifest entry. New
  `GET /api/rooms/resumable` lists closed rooms with on-disk data (including legacy orphans,
  whose name falls back to the latest conversation title); `POST /api/rooms/:id/resume` reopens
  one with its transcript, roster, and scope restored. UI: the “+ room” dialog gains a
  **Create new / Resume** toggle listing resumable rooms (name, last activity, size, scope).

### Fixed

- **Switching rooms mid-turn dropped an agent's in-flight output** — `RoomView` remounted on every
  room switch (`key={activeRoomId}`), tearing down that room's SSE stream and ephemeral streaming
  state; peeking at another room and back lost the partial text until the turn committed to the
  transcript. Every open room's `RoomView` now stays mounted (only the active one is shown, the
  rest `display:none`), each with its own `useRoom` instance — so the stream and live state survive
  switches. Bounded by the 4-room cap. Returning to a room also jumps to the bottom so content that
  streamed in while it was hidden isn't left below the fold.
- **Remote (sshfs) rooms ran ~1 minute per action** — every agent turn snapshotted the whole
  workspace twice (the before/after work-receipt diff) and re-listed it on each event. For a room
  scoped to a large remote directory (e.g. an entire `/home`), that meant `stat`-ing the full tree
  over the network each time — ~a minute per agent. Remote rooms now skip the full-tree snapshot
  and workspace listing, so turns run at inference speed like local rooms. Only the live workspace
  file panel stays disabled for sshfs rooms; **work receipts are preserved** — rebuilt from the
  agent's actually-executed `write`/`edit` tool calls (`receiptFromActivity`), independent of its
  text claims, so the builder→auditor verification handoff still works. (Files changed as a side
  effect of `bash` aren't captured this way — the only gap vs the full snapshot diff.)
- **Editing an agent in a second room edited the main room's agent** — `EditAgent` fetched the
  persona and saved changes through the *global* API (default room), so changing an agent's
  model / prompt / tools while viewing another room hit the wrong room. It now uses the active
  room's scoped fetch + save (threaded via `useRoom.getParticipant` / `updateParticipant`).
- **Resuming an sshfs-scoped room failed with "fusermount3: … Permission denied"** — a mount
  leaked by a previous process (killed before teardown) survived at the room's deterministic
  mountpoint, so re-mounting on resume failed. `mountSshfs` now clears any leftover mount before
  mounting, and the server runs `cleanupStaleMounts()` at startup to unmount everything left under
  the mount base before `restoreRooms()` re-mounts the valid rooms.
- **Preset load no longer blocks on an unavailable model** — a preset referencing a model that
  isn't currently available (a stale cloud snapshot id that rotated out of the registry, or a
  swapped local quant) used to fail the *whole* load with a 400. It now loads, downgrading those
  agents to the process default (matching `resolveModelRef`'s runtime fallback) and telling you
  which: a notice on load plus a small `(!)` marker in the Presets panel next to each unavailable
  model and on the preset card. `downgradeUnavailableModels` replaces the hard pre-check in the
  load/apply routes and sub-room provisioning.
- **Duplicate back-to-back handoffs** — when two agents in the same routing pass both handed off
  to the same agent (e.g. scout and builder both ending on `@planner`), that agent was enqueued
  twice and ran 2–3× in a row. `proposeChain` now de-dupes proposed handoffs against the pending
  queue, so a target already queued for this pass isn't added again (applies to explicit
  @mentions and to the no-handoff fallback). Regression test added (verified failing before).
- **Dropped handoff after answering a question** — with chaining on, if an agent @-mentioned
  another agent in the reply it produced right after the user answered its `ask_user` question,
  that handoff was silently discarded: the resume path pushed the next agent onto a queue it then
  overwrote with the held queue. The two chain-routing sites (the main drain loop and the
  ask-user resume path) are now unified into a single `Room.proposeChain()` helper so routing is
  identical in both — and the post-answer handoff now continues instead of vanishing. Regression
  test added (verified failing before the fix). This also lays the groundwork for an upcoming
  semi-automatic routing mode (human-approved handoffs).
- **Sub-room teardown was a detach, not a stop** — `RoomManager.destroyRoom()` now aborts the
  in-flight pipeline (`await room.abortCurrent()`) BEFORE unmount+delete. Previously a
  destroyed-but-busy room kept running headless (a zombie): its agents continued inference,
  holding the process-global `LocalModelLock` and starving every other room, and wrote into a
  workspace that was about to be unmounted.
- **Goal-eval loop ignored cancellation** — the loop reset `aborted` at the start of every
  iteration, so abort/stop could not terminate an `eval`-mode goal (it spun to the next pass).
  A sticky `goalCancelled` flag — checked between and after each pass, cleared only by
  `submitGoal()` — now makes stop reliable.
- **Eval-mode fallback agent left disabled** — aborting during an eval goal's *initial* drain
  skipped `runGoalEval`'s `finally`, leaving fallback routing suppressed for the room. Now
  restored on the abort path.
- **`tsc --noEmit` regressed to 3 errors** — `circuit-breaker-recovery.test.ts` and
  `local-model-lock.test.ts` (added after the original 122→0 cleanup) reintroduced an invalid
  `WorkReceipt` literal (`{}`) and a `Promise<void>` `run()` override. Fixed; `npm run typecheck`
  is green again as a CI gate.
- **Frontend build was broken** — `web` `npm run build` (`tsc --noEmit && vite build`) failed on
  7 pre-existing type errors in `Composer.tsx` (the `/`-command suggestion union wasn't narrowed
  per `trigger`). Narrowed at the gated render branches; the production build is green again.
  (The dev server was unaffected — Vite doesn't typecheck — which is why it went unnoticed.)
- **Room switch no longer animates a top→bottom scroll** — the transcript remounts on every room
  switch and was smooth-scrolling from the top each time. It now jumps to the bottom instantly on
  a room's initial load and only animates for incremental new messages.
- **Chain-hops field is now editable** — it was a server-controlled value PATCHed on every
  keystroke, so typing fought the async round-trip and an empty/`0` value 400'd. Now a local draft
  applies explicitly on Enter / blur / a ✓ button (only shown when the value changed).

### Changed

- **Roster cards decluttered** — each agent card's row of 8 tiny icon buttons is replaced by a
  clean header (name + at-a-glance **★ default** / **∥ parallel** badges) and a single **⋯**
  overflow menu (Edit, Set as default, Run in parallel, Activate/Deactivate, Compact, Export
  HTML/JSONL, and Kick behind a separator). Clicking a card opens its editor. The menu is a
  `position: fixed` dropdown so it's never clipped by the sidebar's scroll. State (default /
  parallel / active-dimmed) is now glanceable instead of encoded in icon buttons.

---

## 2026-06-19

### Added

- **Role-aware compaction** — each persona can define `compactionInstructions` (max 500 chars)
  telling the compaction what to preserve vs discard. All 7 seed personas have tailored
  instructions. Set via persona editor or PATCH. Only applies to manual compaction
  (SDK limitation — auto-compaction uses default instructions).
- **Work receipts via sendCustomMessage** — after an agent turn with file changes, the next
  agent in the queue receives a structured `work_receipt` custom message summarizing
  what changed (created/modified/deleted). Gives downstream agents filesystem awareness
  without re-reading the transcript.
- **JSONL export** — `GET /api/participants/:id/export-jsonl` exports a session as JSONL
  (one JSON object per line). Useful for post-mortem analysis and dataset extraction.
  Secondary export button in the Roster alongside HTML export.
- **CORS configurable** — `PIPELINE_CORS_ORIGINS` env var (comma-separated) overrides the
  hardcoded `localhost:5310,localhost:5300` defaults.
- **Session naming** — sessions are named by persona id on creation
  (`session.setSessionName(persona.id)`) for debug visibility.
- **`getLastAssistantText()`** — convenience delegate on `Participant` wrapping
  `session.getLastAssistantText()`.

### Fixed

- **`@mention` routing — last-paragraph only** — `resolveAgentMentions()` now only scans
  the last paragraph of an agent's reply. Mid-text references like "as @builder mentioned"
  no longer trigger unintended chains. `ROOM_NOTE` updated with routing instruction.
- **Chain budget (anti-loop)** — each turn has a chain hop budget of 8 (`MAX_CHAIN_HOPS`).
  Exhaustion stops further chains and emits a notice. Budget resets at turn start.
  Guards both chaining call sites in `drainQueue()`.
- **122 TypeScript errors in test files → 0** — aligned `ToolDefinition.execute()` calls
  to the 5-arg signature, added type narrowing for `TextContent | ImageContent` union,
  fixed `TOptional` structure access. `tsc --noEmit` now clean as a CI gate.
- **Memory file read — sync → async** — `Participant.create()` now uses
  `access()`/`readFile()` from `node:fs/promises` instead of `existsSync`/`readFileSync`.
  Image `readFileSync` left synchronous (feeds a sync data structure).

### Changed

- **`start.sh` — single-command launcher** — starts llama-server → backend → frontend
  with health gates between each stage. Ctrl+C kills all three. Added
  `npm run start:full` to `package.json` for discoverability.

- **Dedup `runAgent()`/`followUpAgent()` → `executeAgent()`** — extracted shared logic
  (snapshot → execute → stats → receipt) into `executeAgent(target, context, mode)`.
  Original methods are 2-line thin wrappers. Maintains one place to modify the common path.
