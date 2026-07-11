# Reference — API, SSE, feature details

The operational reference for Pipeline-MoE's HTTP surface and feature
mechanics. For what the system *is* and why, read the [README](../README.md).
Where this document and the source disagree, the source wins — payload shapes
live in `src/server.ts` and `packages/client-core/src/types.ts`.

## HTTP API

All routes exist at the root (`/api/...`, targeting the default room) and
room-scoped (`/api/rooms/:roomId/...`). Rooms are created and listed under
`/api/rooms`.

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/api/health` | — | liveness |
| GET | `/api/events` | — | **SSE** stream (see below) |
| GET | `/api/rooms` | — | list rooms |
| POST | `/api/rooms` | `{name?, preset?, workspace?}` | create a room |
| GET | `/api/participants` | — | roster snapshot |
| POST | `/api/participants` | `{name, systemPrompt, tools?, color?, icon?, id?}` | create a participant |
| POST | `/api/participants/from-template` | `{template, ...overrides}` | create from a seed persona |
| PATCH | `/api/participants/:id` | `{active?, parallel?, model?, thinkingLevel?, skills?, ...}` | edit / activate / deactivate |
| DELETE | `/api/participants/:id` | — | kick |
| POST | `/api/participants/:id/compact` | — | compact the agent session |
| POST | `/api/participants/reorder` | `{order: [id, …]}` | reorder roster |
| GET | `/api/participants/:id/export` | — | session as HTML (attachment) |
| GET | `/api/participants/:id/export-jsonl` | — | session as JSONL (attachment) |
| GET | `/api/transcript` | — | full transcript |
| GET | `/api/conversations` | — | list saved conversations |
| POST | `/api/conversations` | `{name?}` | new conversation |
| POST | `/api/conversations/:id/load` | — | load a conversation |
| PATCH | `/api/conversations/:id` | `{name}` | rename |
| DELETE | `/api/conversations/:id` | — | delete |
| POST | `/api/messages` | `{text, images?: string[]}` | post to the room (202; results stream over SSE) |
| POST | `/api/messages/steer` | `{text, target}` | steer a running agent mid-turn (409 if idle) |
| POST | `/api/abort` | — | abort the running agent (also clears a pause) |
| GET | `/api/media/:filename` | — | serve a saved image |
| GET | `/api/workspace` | — | list workspace files |
| GET | `/api/settings` | — | room settings |
| PATCH | `/api/settings` | see below | update room settings |

### Room settings

`PATCH /api/settings` accepts any subset of:

| Field | Type | Meaning |
|---|---|---|
| `chaining` | boolean | allow agent→agent turns at all |
| `routingMode` | `"auto" \| "supervised" \| "semi" \| "manual"` | free dispatch / supervisor agent decides / human approves / operator routes everything |
| `supervisorAgent` | string | who judges handoff proposals in `supervised` mode (default `"planner"`) |
| `defaultAgent` | string | who receives unaddressed user messages |
| `fallbackAgent` | string | who receives unrouted agent turns |
| `planAwareRouting` | boolean | route to the owner of the next incomplete plan step |
| `maxChainHops` | number | chain budget per turn (loop bound) |
| `defaultThinkingLevel` | string | room-wide thinking level default |
| `allowCloud` | boolean | per-room cloud opt-in |
| `compactionReserveTokens` | number | context headroom that triggers auto-compaction |
| `handoffGates` | `{from, via, when?: string[]}[]` | review gates (see README) |

`GET /api/settings` returns all of the above plus `defaultModel`, `maxRooms`
and `pendingRoute` (the proposal set awaiting a decision — the human's in
semi mode, the supervisor's in supervised mode).

## SSE events

| Event | Payload | Description |
|---|---|---|
| `roster` | `RosterItem[]` | full roster snapshot (on connect and on any change) |
| `message` | `{index, author, authorName, text, ts, question?, images?, handoffTo?}` | a completed transcript line; `handoffTo` names the explicit handoff target if the turn ended with one |
| `token` | `{id, delta}` | streaming text delta |
| `reasoning` | `{id, delta}` | streaming thinking delta (ephemeral) |
| `activity` | `ActivityEvent` | tool-call start/end |
| `status` | `{id, status, contextUsage?, sessionStats?, retry?}` | `idle`, `active`, `thinking`, `working`, `compacting`, `retrying` |
| `receipt` | `{participantId, created[], modified[], deleted[]}` | work receipt (filesystem diff) |
| `notice` | `{msg, level}` | informational/error notice |
| `turn` | `{phase, targets?, askerId?, question?}` | turn lifecycle: `start`, `end`, `chain`, `parallel`, `pause`, `resume` |
| `workspace` | `FileEntry[]` | live workspace file listing |
| `settings` | full settings payload | any room-settings change |
| `routing` | `{roomId, type: "proposed" \| "resolved", …}` | supervised-mode decision lifecycle (proposal set, then verdict) |
| `transcript` | `TranscriptEntry[]` | full replacement (conversation switch) |
| `conversations` | `{conversations, currentId}` | saved-conversation list + current id |
| `tasks` | task board state | shared board changes |

## Routing mechanics

**Handoff tool.** The only way an agent passes its turn is the `handoff`
tool — an explicit call with a target constrained to an enum of currently
active agents. Free-text `@name` in an agent reply does **not** route (agents
can quote and discuss each other safely). The tool enforces, at execution
time: live-roster validity, one handoff per turn (the first registration
stands), and the room's review gates — each violation returns a correctable
error the model reads and recovers from in the same turn.

**User messages** still address agents with `@mentions`: `@builder fix this`
routes to the builder; no mention routes to `defaultAgent`.

**Plan-aware routing.** When an agent ends its turn without handing off and
the workspace has an adopted plan with `[owner]`-prefixed steps, the turn
routes to the owner of the next incomplete step. Otherwise it falls back to
`fallbackAgent`.

**Chain budget.** `maxChainHops` bounds agent→agent chains per user turn.
This — not pattern detection — is the loop safety net (the repetition
circuit breaker was removed deliberately; see the CHANGELOG for the
rationale).

**Routing modes.** `auto` dispatches handoffs immediately; `supervised`
submits each proposal set to the `supervisorAgent` (see below); `semi` holds
each handoff for operator approval (`pendingRoute` in settings, approval UI in
both clients); `manual` disables agent routing entirely.

**Supervised mode.** The supervisor decides in a STATELESS micro-turn: a
disposable in-memory session on the supervisor's model, given the proposal
set, a summary of the proposing turn, and plan/board state, with exactly one
tool — `route_decision({verdict: accept | refuse | transfer, targetIds?,
reason})`. One decision covers the whole proposal set (parallel waves propose
several handoffs). Accept/transfer dispatch; refuse re-runs the proposer with
the reason injected, bounded by an anti-ping-pong cap (an identical
re-proposal after a refuse falls to the fallback). The supervisor's own
proposals auto-accept; plan-owner routing is not supervised (the plan is the
supervisor's own artifact). ANY non-decision outcome — error, abort, timeout,
a turn that never calls the tool — degrades that hop to auto with a notice: a
dead supervisor never deadlocks the room. Every decision leaves a transcript
trace (`✓` / `↪` / `✗` with the reason). Design, retro and phase-2 bench
numbers: `docs/supervised-routing.md`.

## Turn mechanics

**ask_user.** Any agent can pause the pipeline with a clarifying question
(closed-option QCM supported — pickers render in both clients). The room
enters `turn: {phase: "pause"}`, holds the queue, and resumes by delivering
the answer via `followUp()` so it's the next thing the asking agent
processes. Nested questions are supported. Escape hatches: `/cancel` drains
the held queue; `POST /api/abort` aborts outright.

**Steering.** While an agent runs, `POST /api/messages/steer` queues a
redirection the agent sees between tool calls — no abort, no context loss.

**Work receipts.** After every turn the workspace is diffed (`created[]`,
`modified[]`, `deleted[]`), broadcast over SSE, rendered in both clients, and
injected as a compact custom message into the next agent's context — downstream
agents get filesystem awareness without re-discovering changes. Receipts are
invisible in the transcript but consume agent context; they're kept terse.

**Retry awareness.** pi auto-retries transient provider errors; the roster
shows `(attempt/max — error)` in amber and status `retrying`.

## Context management

**Context usage + session stats.** After each turn the roster shows a
color-coded context bar (green < 50%, yellow < 75%, orange < 90%, red above)
and a stats line (tokens in/out, KV-cache hit rate, tool count). Cache hit
rate is the number to watch on local models — a low value means the agent
repays prefill every turn.

**Compaction.** Manual per agent (`POST /api/participants/:id/compact` or
`/compact @agent`) or automatic when context approaches the window minus
`compactionReserveTokens`. Each persona carries `compactionInstructions` —
a role-aware directive for what to preserve (the builder keeps code decisions
and drops failed attempts; the auditor keeps findings and drops clean reads).
Custom instructions apply to manual compaction; auto-compaction uses pi's
defaults (SDK limitation).

**Thinking levels.** Per-agent `thinkingLevel` overrides the room default
(`off` → `xhigh`, filtered to what the model supports). A thinking-level-only
PATCH applies in place without recreating the session.

## Vision

Paste or drag-drop images in either client; `POST /api/messages` accepts
base64 data URIs. Images are content-hashed into the workspace `media/`
directory and served back via `GET /api/media/:filename`. Vision is gated
per agent (`vision` flag) so an image never reaches a model without a
projector.

## Custom tools

`src/custom-tools/` is a drop-a-file registry of pi `ToolDefinition`s, gated
per persona through the `tools` allowlist. Shipped tools:

- **Web**: `web_search` (SearXNG), `web_read`, `youcom_search`,
  `youtube_transcript`, `arxiv_search`
- **Orchestration**: `spawn_room`, `check_room`, `stop_room`, `destroy_room`,
  `answer_room`, `ask_orchestrator` (auto-granted inside spawned rooms)
- **Task board**: `task_create`, `task_update`, `task_list` (granted when the
  room has a board)
- **Turn control**: `handoff` and `ask_user` are granted automatically to
  every agent — they are infrastructure, not allowlist items. `route_decision`
  exists only inside the supervisor's ephemeral micro-session (supervised
  mode); no persona ever holds it. All turn-control tools declare
  `executionMode: "sequential"` — pi runs a batch's tool calls in parallel by
  default, which would make their first-call-stands guards a TOCTOU race

## Seed personas

pi built-ins: `read, bash, edit, write, grep, find, ls`. Gating is a plain
allowlist — no permission shim. `handoff` and `ask_user` are always present.

| Persona | Tools | Skills |
|---|---|---|
| planner | read, grep, find, ls + spawn_room, check_room, stop_room, destroy_room, answer_room | orchestrator |
| scout | read, grep, find, ls + all web tools | — |
| builder | read, bash, edit, write, grep, find, ls | — |
| auditor | read, grep, find, ls | live-verify |
| tester | read, bash, grep, find, ls | live-verify |
| scribe | read, write, edit, grep, find, ls | — |
| fetcher | web_read, bash, read, write, grep, find, ls | — |

Note the deliberate asymmetries: the auditor cannot write (separation of
powers is a locked door, not a convention), the planner cannot touch code
(it orchestrates), and only the builder combines write and bash.

## Session export

Per agent: self-contained HTML (`/export`) for reading, JSONL
(`/export-jsonl`) for post-mortem analysis, dataset extraction, and replay.
Both download as attachments from the roster actions in either client.
