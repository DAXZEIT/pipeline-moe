# Pipeline-MoE

**Think frontier, run local. Compose your team — models, norms and all.**

A multi-agent chat room over N stateful [`pi`](https://github.com/earendil-works/pi)
sessions sharing one transcript and one filesystem workspace. Each seat —
planner, builder, auditor, tester, scribe — runs the model its cognitive
profile deserves: frontier where judgment lives, local 27B where volume
lives, side by side in the same room. Swap any single seat up or down
without touching the rest.

The provenance is part of the design. Claude Opus 4.8 wrote the core; the
pipeline ships features to its own repository, through the same review gates
it enforces on any work; most of the terminal client came from Claude Fable 5
working in Claude Code, with optimization passes run by the stack itself in
parallel. Human input is architecture and review, and every change lands with
receipts — transcripts, workspace diffs, audit passes, 1,000+ tests. That
history is documented live in a blog series:
[the system builds itself](https://blog.daxzeit.eu/the-pipeline-is-building-itself.html) ·
[grows an immune system](https://blog.daxzeit.eu/the-pipeline-grows-an-immune-system.html) ·
[writes its own laws](https://blog.daxzeit.eu/the-pipeline-writes-its-own-laws.html) ·
[the manifesto](https://blog.daxzeit.eu/stop-burning-tokens.html).

## The philosophy: norms, not loops

There is no orchestrator script, no wired graph, no supervisor process.
Agents route themselves — and the system stays honest through a small set of
invariants enforced where they can't be routed around:

- **Explicit handoffs.** The only way to pass a turn is the `handoff` tool —
  a schema-constrained menu of active agents, not free-text `@mentions`. One
  handoff per turn; every transition is visible in the transcript
  (`↪ handoff → @tester`). Agents can quote and discuss each other safely.
- **Review gates.** Room norms as one-liners, not prose:
  `{from: "builder", via: "auditor", when: ["src/**"]}` — while the builder
  has touched matching files this turn, its handoff must target the auditor.
  Enforced inside the tool as a *correctable* error (the agent re-routes
  itself, same turn, agency intact). A gate whose reviewer is inactive
  disarms itself: a dead agent never deadlocks the room.
- **Separation of powers as tool allowlists.** The auditor cannot write. The
  planner cannot touch code. Not conventions — locked doors.
- **Work receipts.** Every turn's filesystem diff is recorded, shown to the
  operator, and injected into the next agent's context. Claims about work
  come with evidence.
- **Culture as files.** Persona-scoped [Agent Skills](skills/) teach
  procedure: the planner carries an orchestration playbook, the auditor and
  tester carry `live-verify` — *"green tests do not count as seeing the
  feature work."* Skills inherit through presets like models do.
- **Boring loop safety.** A chain-hop budget and fallback routing bound
  runaway chains. (A pattern-detecting circuit breaker shipped, misfired in
  both directions, and was deleted — the rationale is in the CHANGELOG.)

## Quick start

**From npm** (no clone needed):
```bash
npx pipeline-moe serve         # server: API + bundled web UI on :5300
npm i -g @pipeline-moe/tui     # terminal client
pmoe                           # connect (defaults to localhost:5300)
```

**From source:**
```bash
git clone https://github.com/DAXZEIT/pipeline-moe && cd pipeline-moe
npm install
npm start          # backend on :5300 (llama-server assumed on :5000)
npm run dev        # backend + web UI dev server (:5310)
bash start.sh      # full launch: llama-server → backend → web UI, health-gated
```

Defaults: port `5300`, workspace = current directory, model = pi's default
local provider (`~/.pi/agent/models.json`). A `.env` in the working directory
is loaded automatically — copy `.env.example`.

**Local-first by policy:** cloud providers are hidden and rejected unless you
opt in with `PIPELINE_ALLOW_CLOUD=1` (and per room with the `allowCloud`
setting). The default posture is your GPU, your data.

## Compose a team

Every seat is independently configurable: model + provider, system prompt,
tool allowlist, skills, thinking level, vision, compaction instructions,
parallel flag. A **preset** serializes the whole composition — roster,
prompts, and review gates — as one shareable JSON file. Ten reference
compositions ship in [`presets/`](presets/), from full-local (runs entirely
on one 24 GB GPU, $0) to all-cloud sprint rosters.

The reference mixed roster:

| Seat | Why this tier | Example |
|---|---|---|
| planner | decomposition and judgment — never writes code | frontier (Opus / Fable) |
| auditor | independent verification of design | frontier or mid-tier |
| scout | fast reconnaissance, web + repo | cheap API (flash-class) |
| builder | implementation volume | local 27B — or frontier for hard sprints |
| tester, scribe, fetcher | diligence, docs, retrieval | local 27B, $0 |

You pay frontier rates only on the decisions that deserve them. If a project
exceeds the local model, swap one seat up and leave the rest alone.

## How a room runs

- **Routing modes** — `auto` (handoffs dispatch freely), `supervised` (each
  handoff is judged by the `supervisorAgent` — accept / refuse with reason /
  transfer — in a disposable micro-session on its model; any non-decision
  degrades the hop to auto, so a dead supervisor never blocks the room),
  `semi` (each handoff pauses for operator approval), `manual` (you route
  everything). Benchmarked: a local 27B holds the supervisor seat at 85%
  rubric alignment, with every miss failing open to auto behavior.
- **Plan-aware routing** — write a plan with `[owner]`-prefixed steps; an
  agent that ends its turn without handing off routes to the owner of the
  next incomplete step.
- **Shared task board** — `task_create/update/list` tools, visible live in
  both clients; the room's working memory for what's in flight.
- **ask_user** — any agent can pause the room with a clarifying question
  (including closed-option picks); the answer resumes exactly where it paused.
- **Mid-turn steering** — redirect a running agent between tool calls without
  aborting it.
- **Per-agent context management** — live context bars, session stats with
  KV-cache hit rate, role-aware compaction (each persona knows what to
  preserve), per-agent thinking levels.
- **Vision** — paste an image to any vision-enabled agent; images never reach
  a model without a projector.

## Scaling out

- **Multi-room** — independent rooms with their own rosters, conversations
  and workspaces, in one server.
- **Sub-rooms** — the planner spawns a delegate room for a bounded
  workstream (`spawn_room`) and is woken with a report when its goal
  resolves; sub-room agents escalate blocking questions back via
  `ask_orchestrator`. Evaluator-loop goals (`goalMode: "eval"`) re-verify
  each pass — build-until-green with the producer never grading its own work.
- **Count backends, not rooms** — parallelism pays only across
  non-contending backends. A local room plus an all-API sub-room genuinely
  run at once; two local-heavy rooms serialize at your GPU. The planner's
  orchestrator skill encodes this and the rest of the delegation playbook.

## Architecture

```
TUI (Ink)                Web UI (React + Vite)
    ╰──────── @pipeline-moe/client-core ────────╯
                    │  REST + SSE
                    ▼
Express backend ──► Rooms (multi-room · sub-rooms report back)
  serial turn queue      │  each room: shared transcript + workspace
  handoff-tool routing   ▼
  review gates      Registry of pi AgentSession instances
  task board             planner / builder / auditor / tester / scribe …
  plan-aware steps       │  each = persona + model + tools + skills
                         ▼
                ┌────────┴────────┐
          llama-server        Cloud APIs
       (any local GGUF)   (Anthropic, OpenRouter, …)
            :5000              on opt-in
```

Each participant is a real pi `AgentSession`: its own conversation memory,
its own tools, the shared transcript threaded into its prompt, the shared
filesystem making every edit visible to the whole team.

Two clients ship on a framework-agnostic core (`@pipeline-moe/client-core`):
the **TUI** (`packages/tui`) — the flagship terminal client: multi-room,
slash commands, live markdown streaming, roster strip, task board, handoff
approval — and the **web UI** (`web/`), the same rooms in the browser.

## Reference

Full HTTP API, SSE events, routing/turn mechanics, seed personas and tool
tables: [`docs/REFERENCE.md`](docs/REFERENCE.md).

## Credits

Built on [pi](https://github.com/earendil-works/pi) by Mario Zechner.
Written by its own agents, under direction by [DAXZEIT](https://about.daxzeit.eu).

## License

[MIT](LICENSE)
