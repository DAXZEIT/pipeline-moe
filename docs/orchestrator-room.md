# The orchestrator room — a console that commands the pipeline from outside it

> Grilling 2026-07-26 (dax + Opus 5). Idea: dax — *"une session solo servira
> certainement de grilling room avec l'orchestrateur… elle bypass la pipeline
> mais a également la capacité de contrôle sur celle-ci"*. Decisions dax took
> during the grilling are marked **DECIDED**; what neither of us has settled is
> in "Open" at the end.
>
> **Built 2026-07-26**, in the order this document argues for: `pipeline_status`
> first, then the grant. Everything in "Design" ships; everything in "Open" does
> not. Live-verified end to end on a scratch instance — a solo console called
> `pipeline_status`, spawned `preset: "pi-audited"`, and was woken by the
> sub-room's report when its goal completed.

## The idea in one line

A `/solo` room stops being a lone pi with file tools and becomes the **console**
of the pipeline: one agent, outside the routing machinery — no queue, no
supervisor, no handoff — holding the five orchestration tools that let it
create, inspect, halt and answer every other room. It is where dax grills the
orchestrator before a chantier, and the orchestrator can act on what comes out
of the grilling without leaving the conversation.

## Glossary

- **External room** — a room that is not a pipeline participant. It is not
  routed to, it does not hand off, nothing dispatches into it except the user
  and orchestrator reports. Today's `/solo` room already is one; what it lacks
  is the control half.
- **Orchestrator seat** — the seat holding `ORCHESTRATION_TOOLS`
  (`src/custom-tools/index.ts:62`). Not a persona, not a role: five names on an
  allowlist. The planner is one today; the solo seat becomes another.
- **Audited sub-room** — a spawned room whose roster is a bare pi *plus*
  verifiers (auditor, tester) running `goalMode: "eval"`. The thing a flat
  sub-agent cannot be, and per dax the reason the stack exists.
- **Pure-pi** — the seat serving the operator's own `~/.pi/agent/SYSTEM.md`
  instead of pi's stock prompt (`src/seat-runtime.ts:297`). Currently detected
  by the persona's system prompt being **empty**. See blocker 1.

## What is already true — the control half is nearly free

The orchestrator is not an entity in this codebase. There is no orchestrator
process, no privileged room, no capability object that only the planner holds:

- `roomManager` injects the same `RoomOrchestrator` into **every** room's
  Registry, solo included (`src/room-manager.ts:173`).
- `buildCustomTools` gates the five tools on `wanted.has(name)` and a live
  orchestrator reference — nothing else (`src/custom-tools/index.ts:96-108`).
- `injectOrchestratorReport(text, agentId)` routes to any agent id, so `@pi`
  in a one-agent room receives sub-room reports and escalations exactly like
  `@planner` does in the default room (`src/room.ts:1546`).

So the grant is five strings added to `soloPersona().tools`
(`src/personas.ts:610`). Everything downstream — report-back on goal
resolution, `ask_orchestrator` arriving as an "Orchestrator" post, `answer_room`
resuming a paused child — already works for a single-agent room.

**`ask_orchestrator` is the child's tool, not the orchestrator's.** It is gated
on `parentLink`, never on the allowlist (`src/custom-tools/index.ts:110-114`).
From the console you do not call it — you *receive* it and reply with
`answer_room`. A solo room that was itself spawned already carries it today.

## Blocker 1 — the empty prompt IS the marker

```ts
// src/seat-runtime.ts:297
const purePi = single && !this.hats[0].systemPrompt && effectiveModel?.provider === "local"
```

`soloPersona` ships `systemPrompt: ""` and that emptiness is not laziness, it is
the predicate that serves dax's own `SYSTEM.md`. Write an orchestration briefing
into the persona and `purePi` silently flips to false: the room stops being pi
and gets the stock prompt. The feature would delete the reason `/solo` exists.

**DECIDED (dax): the solo prompt changes — "il était provisoire de toute
façon".** The correction is *where*: the briefing goes into the assembled
`promptParts` (`src/seat-runtime.ts:262`), beside `workspaceNote` and
`LONE_AGENT_NOTE`, conditioned on the orchestration tools being present. Not
into the persona. That keeps emptiness as the pure-pi marker and keeps `/solo`'s
charter intact: the note is **capability documentation, not a role overlay** —
it says what the tools do, never who the agent is.

There is a second, sharper reason it cannot stay silent. `LONE_AGENT_NOTE`
(`src/seat-runtime.ts:87`) states:

> "You are the only agent in this room… there is no one to hand off to and no
> team protocol to follow."

Grant `spawn_room` and that sentence becomes false — the seat is alone in its
room but commands rooms. The invariant written directly above it, *"the prompt
never promises a mechanism the toolset doesn't carry"*, breaks in the reverse
direction: the toolset would carry a mechanism the prompt denies.

## Blocker 2 — the orchestrator is blind

dax's argument for why the local ceiling is not a problem: *"l'agent dans le
siège orchestrateur voit qui sont ses membres, si deux locaux sont pris, il peut
spawn une room full cloud"*. Correct as a design, but it presupposes three
things the agent cannot observe today.

| It needs to know | Where that lives | Reachable from a turn? |
|---|---|---|
| Which rooms exist, their goals, their rosters | `roomManager.listRooms()` (`src/room-manager.ts:513`), served at `/api/rooms` | **No** — `check_room` needs an id, and the only ids an agent can obtain are ones it spawned itself |
| Which presets exist | `listPresets()` (`src/server.ts:138`) | **No** — `spawn_room({ preset })` takes a name the agent has no way to learn |
| Which models exist, local vs cloud, who holds the local slot | `listModels()` (`src/model.ts:74`), `LocalModelLock` | **No** — no tool, and the lock exposes nothing |

Two more invisible limits sit in the same blind spot: the room cap
(`config.maxRooms`, default 8 — `src/config.ts:59`, enforced
`src/server.ts:376`), and the fact that **the local lock has capacity 1**
(`src/local-model-lock.ts:11`), whose header still claims llama-server runs
`--parallel 1` — stale since 2026-07-18. "Two local slots taken" is not
representable: there is one slot, process-global, and every local room queues on
it.

An orchestrator that can command but not observe cannot make the decision dax
described. **DECIDED (dax, 2026-07-26): build the observation surface.**

### The contract — one tool, not three

`pipeline_status` returns rooms + models + presets + capacity in a single call.
One tool rather than `list_rooms` / `list_presets` / `list_models` for two
reasons: the "local is saturated → go cloud" decision needs all three facts at
once, so three tools is three round trips for one thought; and small models call
whatever they are shown — the reason `goal_verdict` is kept off worker schemas
entirely (the scribe's spurious `task_update`, 2026-07-12,
`src/custom-tools/index.ts:142-148`). Three new names on the console's menu is
three new ways to answer "what should I do next" with a list call.

It composes three functions that already exist. This is an **exposure**, not new
logic — the only new state is the lock's occupancy.

Output is a compact text table, not JSON — same reasoning as `check_room`:

```
ROOMS (3/8)
  default         roster 6   goal: idle
  solo-l8x2k      roster 1   goal: idle                    ← you
  audit-auth      roster 3   goal: running (eval 2/10)     /home/dax/pipeline-moe

LOCAL SLOT: busy — held by audit-auth, 1 waiting
MODELS
  local/GRM 2.6              local
  anthropic/claude-opus-5    cloud
PRESETS
  local-default   6 agents   scout, builder, auditor, scribe, tester, planner
  pi-audited      3 agents   pi, auditor, tester
```

**As built** (`src/custom-tools/pipeline-status.ts`), it rides the orchestrator
gate but is NOT allowlist-gated: any seat already holding a command tool gets
it. Requiring an allowlist entry would have left every planner in every
`presets/*.json` on disk commanding blind until its file was hand-edited — the
same reason the task tools and handoff are context-gated
(`src/custom-tools/index.ts`). Naming it explicitly still works, for a seat that
observes without commanding.

Two things only the live run showed. With `PIPELINE_ALLOW_CLOUD` on, the model
section printed **333 refs** (anthropic + huggingface + openrouter catalogues) —
thousands of tokens of menu to answer "is there a cloud model". Local models are
now listed in full, cloud sampled per provider (5 + a count). And a room's
`goalText` is free-form: a multi-line goal broke every row under it, so it is
flattened and capped.

## Design

### 1. The grant

```ts
// src/personas.ts — soloPersona()
tools: [
  "read", "bash", "edit", "write", "grep", "find", "ls",
  "web_search", "web_read", "youtube_transcript", "arxiv_search", "youcom_search",
  "spawn_room", "check_room", "stop_room", "destroy_room", "answer_room",
  "pipeline_status",
]
```

Plus the conditional note in `promptParts`, per blocker 1. No change to
`Registry`, `Room`, or the orchestrator interface.

**As built**: `ORCHESTRATOR_NOTE` (`src/seat-runtime.ts`) is injected from the
*same* predicate that builds the tools — the seat holds a command tool AND a
live orchestrator exists — so the two halves can never drift apart, in either
direction. It reaches the planner too, which had the identical blind spot. Its
closing sentence is what repairs `LONE_AGENT_NOTE`: *"Being the only agent in
this room does not mean you work alone: here, delegating is spawning a room, not
handing off a turn."*

### 2. `spawn_room({ solo: true })`

`SpawnRoomOptions` accepts `preset` but not `solo` (`src/orchestrator.ts:9`), so
today a console can only delegate to *rosters*. That makes it "pi delegating to
a team", never "pi delegating to pi", and the recursive tree dax wants is not
expressible. `provisionRoom` already implements solo (`src/server.ts:338,347-360`) and
the orchestrator closes over it: this is a schema field and a passthrough.

Mutually exclusive with `preset`, mirroring the HTTP contract, which already
rejects both together with a 400.

**As built**, `model` came along with it. Without it, dax's own scenario is not
expressible: seeing the local slots saturated is useless if the only rooms you
can create are local ones. `provisionRoom` already validates the ref and refuses
an unavailable one, so this is still a passthrough.

### 3. Audited sub-rooms cost a preset file, not code

**This part is already correct and nobody has to touch it.** `purePi` keys on
`single` — *one hat in the seat* (`src/seat-runtime.ts:221`) — not on the number
of agents in the room. So in a `pi + auditor + tester` room:

- pi keeps dax's `SYSTEM.md` (still single, still empty prompt, still local);
- `lone` correctly flips to false (`src/seat-runtime.ts:243`), so the framing
  swaps `LONE_AGENT_NOTE` → `ROOM_NOTE` + roster block, and the handoff tool is
  granted because a real target now exists.

The machinery already does the right thing in both directions. What was missing
is `presets/pi-audited.json` — **now written**, and it holds no orchestration
tool: a spawn target that can itself spawn is how an unbounded tree starts, and
depth is still open. `pi` is not a seed id, so its empty prompt survives
rehydration untouched while the auditor and tester inherit theirs from the seed.
Per dax, this — not `solo: true` — is where the value is: *"une room solo devient simplement un sub-agent, sauf qu'on peut
rajouter un auditeur et pourquoi pas un Tester dans la boucle, c'est la
pertinence de la stack."*

## What this exposes, and nobody has hit yet

Today exactly one seat spawns (the planner) and the tree is one level deep. A
console that spawns consoles makes three latent bugs structural:

1. **Orphaned children.** `destroy_room` does not cascade
   (`src/server.ts:576`). Destroy a parent and its children keep running; their
   `report()` resolves `getRoom(parentId)` → `undefined` → a silent no-op
   (`src/server.ts:441`). Their work disappears without a line in any
   transcript. This is the worst of the three: it fails quietly.
2. **No depth cap.** Nothing counts or limits solo → solo → solo. `parentLink`
   carries `parentRoomId`, so depth is derivable and never derived. The room cap
   of 8 bounds the total but not the shape.
3. **The capacity lie.** `LocalModelLock` was a semaphore of 1 while
   llama-server runs `--parallel 2`. Whatever `pipeline_status` reports about
   the local slot is only as true as the lock — so the capacity setting stopped
   being a nice-to-have and became a prerequisite for the routing decision the
   console is supposed to make. **Fixed halfway**: the semaphore now counts to
   `config.localSlots` and names its holders (the roomId), but the default is
   still **1** — raising it changes how many turns hit the GPU at once, which is
   dax's call against the KV pool, not a silent default change. Until
   `PIPELINE_LOCAL_SLOTS=2` is set, the report is honest about a pipeline that
   under-uses the server.

## Open

- **The pure-pi marker.** Keep emptiness as the signal, or introduce an explicit
  `purePi: true` on `Persona`? Explicit is honest and survives someone adding a
  prompt for an unrelated reason; it costs a field on the type and a migration
  path for persisted rooms.
- **Orphan policy.** Cascade destroy, refuse to destroy a room with live
  children, or re-parent them to the grandparent? A cascade is the only one that
  cannot silently lose work.
- **Depth cap** — a number, or a rule ("a solo room may spawn rosters but not
  solos")? The second kills the recursion class outright at the cost of the tree.
- **Naming.** The persona is `pi` and the room is `solo/<model>`. Once it
  commands the pipeline, "solo" describes its roster and not its job. Rename the
  room kind, or leave it and let the tools speak?
- **Does the console keep bypassing routing forever?** DECIDED yes for now
  (dax: "bypass la pipeline mais contrôle sur celle-ci"). Worth revisiting only
  if the console ever needs more than one seat.

---

Blockers 1 and 2 are the whole design; the rest is wiring. The order that
matters: `pipeline_status` before the grant, because a console that can spawn
before it can see is a console that spawns blind.
