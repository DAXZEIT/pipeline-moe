---
name: roster-author
description: How to compose a room roster from scratch — the preset file format, the seed-id inheritance rule that silently decides whether a persona has an identity at all, model refs that downgrade in silence, and the write→spawn→verify loop. Read this BEFORE writing a preset or spawning a room with a team you invented.
---

# Roster author

A roster is a file. `spawn_room({ preset })` resolves the name against
`presets/<name>.json` in the pipeline workspace and reads it **at spawn time**,
so a preset you write with `write` is usable one tool call later. No API, no
restart, no registration step.

That also means nothing validates your file before a room is built out of it.
Three of the failure modes below produce a room that RUNS and is silently wrong.
Read the inheritance rule before you write anything.

## The loop

1. **`pipeline_status`** — before writing a line. It gives you the exact model
   refs that exist (an invented one does not fail, it downgrades — see below),
   the presets already on disk (reuse beats authoring), and whether the local
   slot is free (a roster of local agents queues on one GPU).
2. **`write presets/<name>.json`** — the format is below.
3. **`spawn_room({ name, goal, preset: "<name>" })`** — same `<name>` as the
   filename.
4. **Verify the room you actually got.** `check_room` shows who spoke. If a
   persona answers with no trace of the role you wrote, you hit rule #1.

Reuse first. `local-default`, `cloud-sprint` and whatever else `pipeline_status`
lists are maintained; a roster you invent is not. Author one when the roles you
need genuinely do not exist, not to rename existing ones.

## The one rule that decides everything: seed id vs invented id

The loader (`rehydrateSeedFields`) looks each persona up **by `id`** in the seed
roster. There are exactly seven seed ids:

    scout   builder   auditor   scribe   planner   tester   fetcher

- **A seed id** may omit `systemPrompt` and `skills` — it inherits them from the
  seed, and it keeps inheriting future improvements. This is the intended way to
  use them. Omission is not laziness here, it is the anti-drift mechanism.
- **An invented id** (`security-reviewer`, `builder2`, `migrator`) inherits
  NOTHING. If you omit `systemPrompt` it has **no role brief at all**.

And the failure is worse than an empty prompt. A seat with no `systemPrompt`
running on a **local** model is indistinguishable from `/solo`'s marker, so it
is served the operator's own pi identity instead of a role. Write a five-agent
roster with invented ids and no prompts on the local model and you get **five
copies of bare pi in different colours**. Nothing errors. The room looks fine
and behaves like one confused agent wearing five hats.

**Rule: an invented id MUST carry a non-empty `systemPrompt`.** Every preset
shipped in this repo already obeys it — look at `cloud-sprint`, where `builder2`
is the only invented id and the only persona carrying a prompt.

Two corollaries worth knowing:

- `"systemPrompt": ""` on a seed id does **not** mean "no prompt". The test is
  falsy, so an empty string inherits exactly like an absent field. To give a
  seed id a custom identity, write a real prompt.
- Reusing a seed id changes its meaning silently. `id: "auditor"` with your own
  `tools` list is still THE auditor, with the seed's prompt and skills. If you
  want a different reviewer, invent an id and write its prompt.

## The file

```json
{
  "name": "audit-sprint",
  "personas": [
    {
      "id": "planner",
      "name": "Planner",
      "color": "#4A90D9",
      "icon": "📋",
      "tools": ["read", "grep", "find", "ls"],
      "model": "anthropic/claude-opus-4-6-20250603",
      "thinkingLevel": "high",
      "active": true,
      "parallel": false
    },
    {
      "id": "security-reviewer",
      "name": "Security Reviewer",
      "color": "#AFA9EC",
      "icon": "🔐",
      "tools": ["read", "grep", "find", "ls"],
      "systemPrompt": "You review changes for authentication, authorization and secret-handling defects. You report findings with file:line and a concrete exploit path, or you report none. You never edit code.",
      "model": "local/GRM 2.6",
      "active": true,
      "parallel": false
    }
  ]
}
```

The top-level `name` must match the filename — `spawn_room` resolves the
FILENAME, while the UI lists the `name` field. Different values give you a
preset that shows up under one name and spawns under another.

### Persona fields

| Field | Required | Notes |
|---|---|---|
| `id` | yes | lowercase slug, also the `@mention` handle. Seed id → inherits; invented id → carries its own prompt. |
| `name` | yes | display name. |
| `color` | yes | hex, `#RRGGBB`. Distinct per persona or the transcript is unreadable. |
| `icon` | yes | one emoji. |
| `tools` | yes | allowlist, see below. |
| `systemPrompt` | for invented ids | the role brief. Absent on a seed id = inherit. |
| `model` | no | `"provider/id"`, exactly as `pipeline_status` prints it. Absent → process default. |
| `thinkingLevel` | no | `off` `minimal` `low` `medium` `high` `xhigh`. Absent → global default. |
| `active` | yes | `false` = present in the roster but never dispatched. |
| `parallel` | no | may run concurrently with ADJACENT parallel-flagged agents. |
| `skills` | no | directory names under the skills dir. On a seed id, absent = inherit the seed's. |
| `compactionInstructions` | no | what the summarizer must preserve for this role. |
| `vision` | no | `false` for a model that cannot take images. |
| `seat` | no | fused seats — advanced, see below. |

Do not write `cursor`: it is runtime state, not configuration.

### Tools

Built-ins: `read` `bash` `edit` `write` `grep` `find` `ls`.
Research: `web_search` `web_read` `youtube_transcript` `arxiv_search`
`youcom_search`.
Orchestration: `spawn_room` `check_room` `stop_room` `destroy_room`
`answer_room` — grant these only to a persona meant to command other rooms, and
remember that a room that can spawn can spawn a spawner.

Never list `handoff`, `task_create`, `task_update`, `task_list`,
`ask_orchestrator`, `goal_verdict` or `pipeline_status`. They are granted from
context, not from the allowlist — a room with a board gives every agent the task
tools, a room with more than one active agent gives everyone `handoff`, a
sub-room gives everyone `ask_orchestrator`. Listing them is harmless but
misleading; omitting them costs nothing.

Unknown tool names are silently ignored. A typo (`websearch`) does not fail the
spawn, it just removes the capability.

### Gates (optional)

    "handoffGates": [{ "from": "builder", "via": "auditor", "when": ["src/**"] }]

A builder turn that touched `src/**` can then only hand off to the auditor. A
preset describes the WHOLE room composition, so a preset without `handoffGates`
clears any gates the room had.

### Fused seats (optional)

`"seat": "<id>"` makes several personas share one context, each becoming a
per-turn hat. Every hat of a seat must resolve to the same model or the seat
defuses loudly. Use it for a frontier/27B line-up; keep one role per context on
small models.

## Composing a roster that works

- **Roles must differ epistemically, not cosmetically.** Two builders with
  different colours are one builder. A reviewer that can edit is not a reviewer.
  The value of a roster is that someone can contradict someone else.
- **Never let a producer grade its own work.** If the roster has a verifier,
  give it read-only tools.
- **Count backends, not agents.** Every `local/…` persona queues on the same
  GPU; a roster of six local agents is six sequential turns. Real concurrency
  comes from mixing local and API models. Check `pipeline_status` for how many
  local slots exist and how many are in use.
- **Smallest roster that can do the job.** Each persona is a full context; the
  cost of an agent that adds no distinct view is paid on every turn.
- **`parallel` only for agents that share no files.** Two parallel writers on
  the same paths: last write wins and nobody notices.

## Failure modes, and what they look like from outside

| Symptom | Cause |
|---|---|
| An agent answers as generic pi, ignoring its role | invented id with no `systemPrompt` on a local model (rule #1) |
| An agent behaves like the seed role, not yours | you reused a seed id; the seed prompt won |
| Everyone runs on the same model despite your `model` fields | the refs do not exist — unavailable models **downgrade to the default silently**, they do not fail the spawn. Re-check against `pipeline_status`. |
| `spawn_room` → `preset "X" not found`, right after you wrote it | invalid JSON. The reader cannot distinguish a parse error from a missing file. Re-read the file and check it parses. |
| `preset "X" has no personas` | `personas` empty or misspelled |
| A capability you granted is absent | unknown tool name, silently dropped |
| `room limit reached` | the pipeline cap counts ALL rooms — destroy a finished one first |

## Cleanup

A preset you write stays on disk and shows up in the operator's UI forever.
Name it for what it is (`audit-sprint`, not `test2`), and delete one-shot
rosters when the workstream is done. If a roster proves itself, say so — a
preset worth keeping is worth the operator knowing about.
