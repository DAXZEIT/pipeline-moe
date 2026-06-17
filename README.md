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
| `status` | `{id, status}` | participant status (`idle`, `active`, `thinking`, `working`, `compacting`) |
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

## Tools per Persona

pi built-in tool names: `read, bash, edit, write, grep, find, ls`. Gating is a
plain allowlist passed to `createAgentSession({ tools })` — no permission shim.
The `ask_user` tool is available to **all** agents.

| Persona | Tools |
|---|---|
| scout | read, grep, find, ls, ask_user |
| builder | read, write, edit, bash, grep, find, ls, ask_user |
| auditor | read, grep, find, ls, ask_user |
| scribe | read, write, edit, grep, find, ls, ask_user |
| tester | read, bash, grep, find, ls, ask_user |
