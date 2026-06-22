# Changelog

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
