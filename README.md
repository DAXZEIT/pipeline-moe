# Pipeline-MoE

Multi-agent chat room backend. Orchestrates **N stateful `pi` agent sessions**
(one per persona, same local model, different system prompts + tool sets) over a
**shared workspace**, routes `@mentions` through a **serial queue**, and streams
everything to a UI over **SSE**.

```
Chat room UI (React, later)
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
| GET | `/api/events` | — | **SSE** stream (roster, message, token, status, receipt, notice, turn) |
| GET | `/api/participants` | — | roster snapshot |
| POST | `/api/participants` | `{name, systemPrompt, tools?, color?, icon?, id?}` | **create** a participant |
| PATCH | `/api/participants/:id` | `{active: boolean}` | **activate / deactivate** |
| DELETE | `/api/participants/:id` | — | **kick** |
| GET | `/api/transcript` | — | full transcript |
| POST | `/api/messages` | `{text}` | post to the room (returns 202; results stream over SSE) |
| POST | `/api/abort` | — | abort the currently running agent |

In-room slash commands (sent via `/api/messages`): `/kick @x`,
`/activate @x`, `/deactivate @x`. `@all` or no mention routes to every active
participant; `@scout @auditor …` routes to those, in order.

## SSE events

- `roster` — full roster array (on connect and on any change)
- `message` — a completed transcript line `{index, author, authorName, text, ts}`
- `token` — streaming delta `{id, delta}`
- `status` — `{id, status}` (idle | active | thinking | working)
- `receipt` — `{participantId, created[], modified[], deleted[]}`
- `notice` — `{msg, level}`
- `turn` — `{phase: "start"|"end", targets?}`

## Tools per persona

pi built-in tool names: `read, bash, edit, write, grep, find, ls`. Gating is a
plain allowlist passed to `createAgentSession({ tools })` — no permission shim.

| Persona | Tools |
|---|---|
| scout | read, grep, find, ls |
| builder | all |
| auditor | read, grep, find, ls |
| scribe | read, write, edit, grep, find, ls |
| tester | read, bash, grep, find, ls |

## Next

- React room UI (roster, `@mention` autocomplete, colored bubbles, receipts).
- Optional: persisted sessions (`SessionManager.create`) + replay of missed
  transcript when a participant is re-activated.
