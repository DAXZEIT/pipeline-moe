# Pipeline-MoE

Multi-agent chat room backend. Orchestrates **N stateful `pi` agent sessions**
(one per persona, same local model, different system prompts + tool sets) over a
**shared workspace**, routes `@mentions` through a **serial queue**, and streams
everything to a UI over **SSE**.

```
Chat room UI (React + Vite)
        │  REST + SSE
        ▼
Express backend  ──►  Registry of pi AgentSession instances
  serial queue         scout / builder / auditor / scribe / tester
  routing @mentions          │  each = createAgentSession(persona, tools)
  workspace diff             ▼
                       llama-server :5000  (Qwopus 27B, --parallel 1)
```

Each participant is a real `pi` `AgentSession`: it keeps its **own conversation
memory** (stateful) and gets **real tools** (read/bash/edit/write, gated per
persona). The shared room transcript is threaded into each agent's prompt so they
see each other's messages; they share the filesystem so edits are visible across
agents. After every agent turn the workspace is diffed to produce a **work
receipt**.

## Run

```bash
cd /home/dax/pipeline-moe
npm install
# pass env via --env-file (Node 20.6+/26 supports it):
node --env-file=.env node_modules/.bin/tsx src/server.ts
# or just: npm run dev   (uses defaults from src/config.ts)
```

Defaults: port `5300`, workspace `./workspace`, model = pi's default (your local
provider in `~/.pi/agent/models.json`). Override via `.env` (see `.env.example`).

## API

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/api/health` | — | liveness |
| GET | `/api/events` | — | **SSE** stream (roster, message, token, status, receipt, notice, turn, etc.) |
| GET | `/api/participants` | — | roster snapshot |
| POST | `/api/participants` | `{name, systemPrompt, tools?, color?, icon?, id?}` | **create** a participant |
| PATCH | `/api/participants/:id` | `{active: boolean}` or `{parallel: boolean}` | **activate/deactivate** or **toggle parallel** |
| DELETE | `/api/participants/:id` | — | **kick** |
| POST | `/api/participants/:id/compact` | — | **compact** agent session (free context tokens) |
| POST | `/api/participants/reorder` | `{order: [id, …]}` | **reorder** roster |
| GET | `/api/transcript` | — | full transcript |
| GET | `/api/conversations` | — | list saved conversations |
| POST | `/api/conversations` | `{name?}` | create a new conversation |
| POST | `/api/conversations/:id/load` | — | load a saved conversation |
| PATCH | `/api/conversations/:id` | `{name: string}` | rename a conversation |
| DELETE | `/api/conversations/:id` | — | delete a conversation |
| POST | `/api/messages` | `{text, images?: string[]}` | post to the room (returns 202; results stream over SSE) |
| POST | `/api/messages/steer` | `{text, target}` | steer a running agent mid-turn (409 if not running) |
| GET | `/api/participants/:id/export` | — | download session as HTML (attachment) |
| GET | `/api/participants/:id/export-jsonl` | — | download session as JSONL (attachment) |
| POST | `/api/abort` | — | abort the currently running agent |
| GET | `/api/media/:filename` | — | serve a saved image |
| GET | `/api/workspace` | — | list workspace files |
| GET | `/api/settings` | — | room settings |
| PATCH | `/api/settings` | `{chaining?: boolean, defaultAgent?: string}` | update room settings |

## SSE Events

| Event | Payload | Description |
|---|---|---|
| `roster` | `RosterItem[]` | full roster snapshot (on connect and on any change) |
| `message` | `{index, author, authorName, text, ts, question?, images?}` | a completed transcript line |
| `token` | `{id, delta}` | streaming text delta from an agent |
| `activity` | `ActivityEvent` | tool-call start/end (live process visibility) |
| `reasoning` | `{id, delta}` | streaming thinking delta (ephemeral) |
| `status` | `{id, status, contextUsage?, sessionStats?, retry?}` | participant status (`idle`, `active`, `thinking`, `working`, `compacting`, `retrying`). After each turn, `contextUsage` and `sessionStats` included when available. During retries, `retry` metadata is included.
| `receipt` | `{participantId, created[], modified[], deleted[]}` | work receipt (filesystem diff) |
| `notice` | `{msg, level}` | informational/error notice |
| `turn` | `{phase, targets?, askerId?, question?}` | routing turn lifecycle |
| `workspace` | `FileEntry[]` | live workspace file listing |
| `settings` | `{chaining, defaultAgent}` | room settings change |
| `transcript` | `TranscriptEntry[]` | full transcript replacement (on conversation switch) |
| `conversations` | `{conversations, currentId}` | saved-conversation list + current id |

**Turn phases:** `start`, `end`, `chain`, `parallel`, `pause`, `resume`

## Features

### `@mention` Routing

`@all` or no mention → every active participant. `@scout @auditor` → those agents,
in order. An agent can hand work to another by writing `@<id>` explicitly in its
reply — only the `@` prefix triggers a handoff. Agents can refer to each other by
name (e.g. "the builder") in discussion without triggering routing.

**Last-paragraph parsing:** Only the last paragraph of an agent's reply is scanned
for `@mentions`. Mid-text references like "as @builder mentioned" don't trigger
chains — only the final paragraph is treated as a routing signal. This prevents
accidental chaining when an agent references another agent in its reasoning.

**Chain budget:** Each turn has a chain hop budget of 8 (configurable as
`MAX_CHAIN_HOPS` in `Room`). If the budget is exhausted during chaining, further
chains stop and a notice is emitted. This prevents infinite loops from agents
that hallucinate `@mentions` in their replies. The budget resets at the start of
each turn.

### Parallel Agents

A participant can be toggled as "parallel" — when routed alongside other agents,
they run in the same wave instead of sequentially. Toggled via `PATCH /api/participants/:id`
with `{parallel: true}`.

### `ask_user` — Agent-Initiated Questions

Any agent can call the `ask_user` tool to pause the pipeline and ask the user a
clarifying question. The pipeline enters a "paused" state (SSE event:
`turn: {phase: "pause", askerId, question}`) and holds the remaining queue. The
user's response is routed back to the asking agent, and the held queue resumes.

Nested questions are supported (an agent can ask again during a resumed turn).

**Escape hatches:**
- `/cancel` — cancels the pause and drains the held queue normally
- `POST /api/abort` — aborts the current agent (also clears a pause)

### Per-Agent Compaction

**Manual:** `POST /api/participants/:id/compact` or `/compact @agent` slash
command. Calls `AgentSession.compact()` and returns the token count before
compaction. The agent's status changes to `compacting` during the operation.

**Automatic:** Each agent session is configured with auto-compaction enabled.
When an agent's context approaches its limit (90K tokens for a 128K window),
pi automatically compacts the session. The UI receives a `status: "compacting"`
event during the operation.

**Role-aware compaction:** Each persona can define `compactionInstructions` —
a short directive (max 500 chars) telling the compaction what to preserve vs
discard. The 7 seed personas come with tailored instructions:

| Persona | Instruction |
|---|---|
| scout | Preserve file paths, structural observations, anomalies. Discard dead-ends. |
| builder | Preserve code changes, bugs, architectural decisions. Discard failed attempts. |
| auditor | Preserve findings, severity assessments, verification status. Discard clean reads. |
| scribe | Preserve documentation written, memory updates, knowledge distilled. Discard context reads. |
| planner | Preserve plans, steps, architectural decisions. Discard source reads for verification. |
| tester | Preserve test results, pass/fail counts, bugs found. Discard superseded runs. |
| fetcher | Preserve URLs and key findings. Discard failed fetches and retry traces. |

Set via the persona editor (textarea below system prompt) or `PATCH /api/participants/:id`
with `{compactionInstructions: "..."}`. Null or empty string clears the override.

**SDK limitation:** Custom instructions only apply to *manual* compaction via
`session.compact(customInstructions)`. Auto-compaction uses default instructions —
the SDK's `session_before_compact` event doesn't expose `customInstructions`
(known pi SDK limitation, requires SDK update to fix).

### Per-Agent Thinking Level

Each agent can override the global thinking level (set by `PIPELINE_THINKING` env
var, defaults to `"medium"`). Set via the persona editor or `PATCH /api/participants/:id`
with `{thinkingLevel: "high"}`.

**Available levels:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`

**Fallback:** When a persona has no `thinkingLevel` set, it inherits the global
config value. Setting `thinkingLevel` to `null` or `""` via PATCH resets the
per-agent override and reverts to the global default.

**Data flow:** `Persona.thinkingLevel ?? config.thinkingLevel` →
`createAgentSession({ thinkingLevel })` → session uses it for reasoning effort.

**Fast path:** If `thinkingLevel` is the *only* field in the PATCH payload, the
backend calls `session.setThinkingLevel()` in-place — no session recreation, no
cursor reset, no "room is busy" block. Takes effect on the next turn. Combined
patches (e.g. thinkingLevel + name) still take the heavy dispose+recreate path.

**Available levels filter:** `GET /api/participants/:id` returns
`availableThinkingLevels` from `session.getAvailableThinkingLevels()`. The
EditAgent selector only shows levels the model actually supports — falls back to
all 6 if the session returns nothing.

The PATCH endpoint validates values against the allowlist — invalid values return 400.

### Context Usage per Agent

After each agent turn, the UI shows a progress bar in the Roster with the agent's
current context token usage (e.g. "42K / 128K"), color-coded by threshold.

**Data flow:** `AgentSession.getContextUsage()` → `Participant.getContextUsage()` →
`Room.runAgent()` broadcasts via SSE `status` event (piggyback, no new event type).

**Color thresholds** (inclusive boundaries):
- Green: < 50%
- Yellow: 50–75%
- Orange: 75–90%
- Red: > 90%

**Warning:** When usage exceeds 80%, the bar pulses (CSS animation `ctx-pulse`)
to alert the operator that compaction may be needed before the loop completes.

**Visibility:** Bars appear after the agent's first completed turn (SSE event
must carry `contextUsage`). Mid-turn status events (e.g. `working`, `compacting`)
don't include `contextUsage` — the last known value persists through the turn.
Bars are hidden when `contextUsage` is `undefined` (fresh load before any turn).

**Why piggyback on `status` and not a new event?**
The `idle` status already fires at the end of every turn. Adding a new SSE event
type would require a new listener in the frontend. Extending the existing `status`
event's payload is simpler — the frontend already processes status events and
updates roster items.

### Vision — Image Support

Users can send images alongside text messages. Images are saved as hashed files
in the workspace `media/` directory and served via `GET /api/media/:filename`.

- **Paste or drag-drop** images in the UI (clipboard and drag-drop handlers on
  the Composer)
- Images stored as `media/<md5hash>.<ext>` in the transcript
- Clicking a thumbnail opens full-size
- JSON body of `POST /api/messages` accepts `{text, images?: string[]}` where
  images are base64 data URIs

### Conversations

Rooms can save and switch between multiple conversations. The transcript is
persisted as a session file, and `GET /api/conversations` lists all saved ones.

### Workspace Diffing (Work Receipts)

After every agent turn, the workspace is diffed to produce a work receipt
(`created[]`, `modified[]`, `deleted[]`). Receipts are broadcast via SSE and
displayed in the UI.

### Slash Commands

| Command | Effect |
|---|---|
| `/kick @x` | Remove a participant |
| `/activate @x` | Activate a deactivated participant |
| `/deactivate @x` | Deactivate a participant |
| `/compact @x` | Compact an agent's context |
| `/cancel` | Cancel a paused question and drain the held queue |

### Session Stats per Agent

After each agent turn, the UI shows a compact stats line in the Roster with token
breakdown and cache efficiency (e.g. "42Ki · 1.2Ko · cache 93% · 3 tools"). Full
numbers in a tooltip.

**Data flow:** `AgentSession.getSessionStats()` → `Participant.getSessionStats()` →
`Room.runAgent()` / `followUpAgent()` broadcasts via SSE `status` event alongside
`contextUsage`.

**Cache percentage** is the most operationally useful number — it shows KV cache
hit ratio. A low percentage means the agent is repaying prefill on every turn.

### Mid-Turn Steering

When an agent is running, the operator can send a redirection message via `steer()`
instead of aborting. The Composer shows "↪ Steer @id" (amber button) alongside
"■ Stop" when `turnActive` is true.

**Data flow:** `POST /api/messages/steer` with `{ text, target }` →
`Room.steer(targetId, text)` → posts `↳ steered @id: text` to the transcript →
`Participant.steer(text)` → `session.steer(text)` queues the message.

The agent sees the steer between tool calls — it doesn't interrupt current tool
execution. A "steer sent" flash appears for 2 seconds, then clears.

**Error handling:** 409 if the agent is not running (idle), 404 if not found.

### Work Receipts (Context Injection)

In addition to workspace diff receipts (filesystem changes broadcast via SSE),
the room injects structured work receipts into downstream agents' context using
`session.sendCustomMessage()`. After an agent turn produces file changes, the
next agent in the queue receives a compact `work_receipt` custom message
(`display: false`) summarizing what changed — e.g. "Builder created: foo.ts,
bar.ts; modified: baz.ts".

This gives downstream agents filesystem awareness without requiring them to
re-discover changes from the transcript. The receipt is injected in `drainQueue()`
after the result is posted.

**Caveat:** `sendCustomMessage({ display: false })` messages still consume context
tokens. In a chain of 8 agents, up to 7 receipts can accumulate per turn.
Keep receipts compact. Receipts are invisible to the operator (not shown in the
transcript) but occupy space in the agent's context — monitor token growth on
downstream agents in long chains.

### Session Export

**HTML:** Export an agent's session as a self-contained HTML file via
`GET /api/participants/:id/export`. The download button (⬇) in the Roster actions
row triggers the download.

**Data flow:** `session.exportToHtml()` → writes HTML file to disk → server reads
and returns with `Content-Disposition: attachment`.

Filename format: `{id}-{timestamp}.html` (colons and dots sanitized).

**JSONL:** Export an agent's session as JSONL (one JSON object per line) via
`GET /api/participants/:id/export-jsonl`. Useful for post-mortem analysis,
dataset extraction, and replay. The Roster has a secondary export button for
JSONL format. Returns the file as `Content-Disposition: attachment` with
`application/x-ndjson` content type.

### Retry Awareness

When pi auto-retries after transient errors (e.g., rate limits on remote models),
the UI shows a `(attempt/maxAttempts — errorMessage)` indicator in amber in the
Roster. The agent's status changes to `retrying` during the retry delay.

**Data flow:** `auto_retry_start` event → `Participant.onEvent()` emits `retrying`
status with metadata → SSE `status` event → Roster renders retry indicator.

### followUp() — Self-Chaining

When an agent asks a question via `ask_user` and the user responds, the answer is
delivered via `followUp()` instead of `prompt()`. This guarantees the answer is the
next thing the agent processes — no Room routing, no context rebuild from transcript.

**Data flow:** User answer → `Room.followUpAgent(asker, { text, images })` →
`Participant.followUp(text, images)` → `session.followUp(text, images)` → agent
processes the answer directly from its session memory.

**Implementation note:** `runAgent()` and `followUpAgent()` are thin wrappers around
a shared `executeAgent(target, context, mode)` method — only the call to
`target.run()` vs `target.followUp()` differs. The common path (snapshot →
execute → stats → receipt) lives in one place.

## Custom Tools (Extension System)

The `src/custom-tools/` directory is a drop-a-file registry for agent tools.
Each tool is a `ToolDefinition` — same type used by Pi's extension system.
Adding a new tool is: create the `.ts` file, register it in `index.ts`, add the
name to `VALID_TOOLS` and `ALL_TOOLS`.

**How it works:**
1. `buildCustomTools(allowlist)` — checks the agent's `tools` allowlist against
   registered tools, returns only the tools that agent is permitted to use
2. Custom tools are merged into `customTools` in the session config alongside
   confined tools (sandbox-tools)
3. Opt-in via `persona.tools` allowlist — scout gets `web_search` by default,
   other agents need it added manually

**First tool: `web_search`** — SearXNG via HTTP GET to
`https://searxng.example.org/search?q=...&format=json`. No external dependencies,
pure Node `fetch()`. Parameters: `query` (required), `limit` (1-20, default 5),
`categories` (optional). Returns formatted results (title, URL, snippet —
truncated at 200 chars). 15s timeout on fetch. Graceful error handling (network
error, HTTP error, abort, empty results).

## Tools per Persona

pi built-in tool names: `read, bash, edit, write, grep, find, ls`. Gating is a
plain allowlist passed to `createAgentSession({ tools })` — no permission shim.
The `ask_user` tool is available to **all** agents. Custom tools are opt-in via
the `tools` allowlist — `web_search` is available but only scout gets it by
default.

| Persona | Tools |
|---|---|
| scout | read, grep, find, ls, web_search, ask_user |
| builder | read, write, edit, bash, grep, find, ls, ask_user |
| auditor | read, grep, find, ls, ask_user |
| scribe | read, write, edit, grep, find, ls, ask_user |
| planner | read, grep, find, ls, ask_user |
| tester | read, bash, grep, find, ls, ask_user |
| fetcher | read, bash, write, grep, find, ls, web_read, ask_user |
