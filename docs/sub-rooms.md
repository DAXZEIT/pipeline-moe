# Sub-Rooms — Spawning and Managing Parallel Workstreams

> Pipeline-MoE sub-rooms: autonomous parallel rooms with their own agents and goals.

---

## When to Use

Spawn a sub-room when you need to delegate a **bounded, self-contained** task
that can run in parallel with the current conversation. Sub-rooms have their own
agent roster, transcript, and workspace scope — they do NOT share conversation
context with the parent room.

Good candidates:
- Writing tests for a specific module
- Auditing a subsystem
- Refactoring a bounded piece of code
- Any task with clear exit criteria

Bad candidates:
- Tasks that need ongoing back-and-forth with the user
- Work that depends on parent-room context the sub-room can't access
- Unbounded exploration

---

## Four Tools

Agents inside a pipeline-moe room get four sub-room tools:

### `spawn_room` — Create a sub-room

```
spawn_room({
  name: "audit-auth-flow",         // display name (required)
  goal: "...",                      // self-contained goal text (required)
  goalMode: "eval",                 // "auto" | "eval" (optional, default "auto")
  preset: "local-default",          // roster preset (optional)
  workspaceDir: "/path/to/scope",   // local path or sshfs target (optional)
  goalEvaluator: "planner",         // agent id for eval mode (optional, default "planner")
  maxGoalIterations: 10,            // 1-50, eval mode only (optional, default 10)
})
```

Returns `{ roomId, name, goalStatus }`. The room starts immediately.

### `check_room` — Poll status

```
check_room({ roomId: "room-abc123" })
```

Returns goal status (`idle` / `running` / `completed` / `failed` / `cancelled`),
goal text, and the last few transcript messages. Poll until status is `completed`,
`failed`, or `cancelled`.

### `stop_room` — Halt without destroying

```
stop_room({ roomId: "room-abc123" })
```

Aborts the room's running agents and cancels its goal (status → `cancelled`)
**without tearing the room down**. The room and its transcript survive, so you can
`check_room` to see *why* it ran away before deciding to re-dispatch or destroy.
Use this when a sub-room loops, drifts off-goal, or is simply no longer needed.

- Cancellation is sticky: it terminates an `eval`-mode goal even mid-evaluation
  (the goal-eval loop checks for it between and after every pass).
- The **default room cannot be stopped** — it is the orchestrating planner's own
  room; stopping it would abort the planner mid-turn.

### `destroy_room` — Clean up

```
destroy_room({ roomId: "room-abc123" })
```

Aborts the room (same as `stop_room`), then tears it down and unmounts any sshfs
target. Call after collecting the result. Destroying a *busy* room is safe: the
in-flight pipeline is aborted before the workspace is unmounted, so no zombie is
left holding the local-model lock.

---

## Goal Modes

### `"auto"` (default)

The goal completes automatically when the pipeline drains (all agents finish
their turns with no further @-mentions). Simple fire-and-forget.

- Good for: straightforward tasks where you trust the agents to self-organize
- Risk: goal may "complete" before the work is actually done if agents finish
  talking without verifying

### `"eval"` (recommended for real work)

After each pipeline drain, the **evaluator agent** (default: planner) re-enters
the room with a structured verification prompt. The evaluator:

1. Uses tools (read, grep, bash, etc.) to check the goal condition against
   the actual workspace state — not just what agents claimed
2. Either dispatches more work by @-mentioning an agent, or declares `GOAL_MET`
3. Loop repeats until `GOAL_MET` or `maxGoalIterations` exhausted

The eval prompt injected into the evaluator each iteration:

```
(GOAL EVALUATION — iteration N of at most M)

You are the goal controller for this room. The goal condition is:
  "<goal text>"

Evaluate whether this condition is genuinely met RIGHT NOW.
Do not take the other agents' word for it — use your tools to verify.

Then choose exactly one:
• NOT MET — explain what's missing, @mention the agent to fix it
• MET — write GOAL_MET on its own line, explain what you verified
```

**Key behaviors:**
- Fallback routing is suppressed during eval mode (prevents double-invocation)
- Circuit breaker trips abort the goal as `"failed"`
- The evaluator must write `GOAL_MET` (case-insensitive, with optional
  separator: `GOAL_MET`, `GOAL MET`, `goal-met` all work)
- `GOAL_MET` is only detected in the evaluator's most recent message

---

## HTTP API (Alternative to Agent Tools)

If you're outside the pipeline (e.g. in a Claude Code session managing the
pipeline), use the REST API directly:

### Spawn

```bash
curl -s -X POST http://localhost:5300/api/rooms \
  -H "Content-Type: application/json" \
  -d '{
    "name": "sandbox-tools-tests",
    "goal": "Write tests for sandbox-tools.ts covering...",
    "goalMode": "eval",
    "goalEvaluator": "planner",
    "maxGoalIterations": 10
  }' | python3 -m json.tool
```

### Check status

```bash
curl -s http://localhost:5300/api/rooms/<roomId> | python3 -m json.tool
```

Response includes: `roomId`, `name`, `goalStatus`, `goalText`, `isBusy`,
`transcriptLength`, `workspaceDir`.

### Destroy

```bash
curl -s -X DELETE http://localhost:5300/api/rooms/<roomId>
```

### Stop (halt without destroying)

```bash
curl -s -X POST http://localhost:5300/api/rooms/<roomId>/abort
```

Aborts running agents and cancels the goal (status → `cancelled`); the room
survives. This is the HTTP equivalent of the `stop_room` tool and what a per-room
Stop button in the UI calls.

### List all rooms

```bash
curl -s http://localhost:5300/api/rooms | python3 -m json.tool
```

### Concurrency cap

The total number of rooms (default room included) is capped by
`PIPELINE_MAX_ROOMS` (default `8`). `spawn_room` / `POST /api/rooms` reject with
`429` past the cap — every local room contends for the single llama-server slot,
so unbounded spawning starves the pipeline. Stop or destroy a room to free a slot.

---

## Workspace Scoping

By default, sub-rooms share the pipeline's workspace directory. You can scope
a room to a different directory:

- **Local path:** `"workspaceDir": "/home/dax/other-project"` — the room's
  file tools are confined to this directory
- **Remote (sshfs):** `"workspaceDir": "dax@10.0.0.1:/home/dax/project"` —
  the pipeline mounts the remote path via sshfs automatically and unmounts
  on `destroy_room`

---

## Presets

Presets define which agents (personas) and models are in the room's roster.
Available presets live in the `presets/` directory. Pass the preset name
(without `.json`) to `spawn_room`:

```
spawn_room({ name: "fast-audit", goal: "...", preset: "local-default" })
```

Omitting `preset` uses the server's default roster (all seed personas).

---

## Writing Good Goals

The goal text is the single most important input. The evaluator reads it
literally and checks each condition with tools.

**Good goal:**
> Ensure `src/__tests__/sandbox-tools.test.ts` exists with tests covering:
> (1) buildConfinedTools returns correct tools for various inputs,
> (2) confined tools reject paths outside workspace root,
> (3) ask_user tool returns terminate:true,
> (4) bash tool gets cwd set to workspace root.
> All tests must pass with `npx vitest run src/__tests__/sandbox-tools.test.ts`.

Why it works:
- Each criterion is independently verifiable with tools
- The final condition ("all tests must pass") is a concrete bash check
- No subjective language ("comprehensive", "good", "clean")

**Bad goal:**
> Write good tests for sandbox-tools.ts

Why it fails:
- "Good" is subjective — the evaluator can't verify it
- No specific criteria to check
- No exit condition

**Rules of thumb:**
1. Number your criteria — the evaluator checks them as a list
2. End with a concrete verification command (test runner, type checker, etc.)
3. Make each criterion checkable with a single tool call
4. Don't include context the sub-room already has (it reads the codebase)
5. Keep it under ~200 words — the evaluator re-reads it every iteration

---

## Lifecycle Summary

```
spawn_room(goal, mode="eval")
  │
  ├─ Room created, agents loaded, goal submitted
  │
  ├─ Pipeline runs: goal text dispatched to first agent
  │  └─ Agents chain via @mentions until pipeline drains
  │
  ├─ [eval mode] Evaluator enters with verification prompt
  │  ├─ Tools verify workspace state
  │  ├─ NOT MET → @mention agent → pipeline runs → re-evaluate
  │  └─ GOAL_MET → goal status = "completed"
  │
  ├─ [auto mode] Pipeline drains → goal status = "completed"
  │
  ├─ check_room() → read status + last messages
  │
  ├─ [optional] stop_room() → abort + goal status = "cancelled" (room survives)
  │
  └─ destroy_room() → abort (if still running) + clean up resources
```

---

## Failure Modes

| Failure | Cause | Result |
|---------|-------|--------|
| Max iterations exhausted | Evaluator keeps dispatching without convergence | `goalStatus: "failed"`, reason: `"max-iterations"` |
| Circuit breaker trips | Agent loops on repeated tool calls or text | `goalStatus: "failed"`, reason: `"aborted"` |
| Evaluator not found | `goalEvaluator` doesn't match a persona id | Falls back to auto-completion (no verification) |
| No GOAL_MET token | Evaluator says "done" without the magic word | Loop continues, eventually exhausts budget |
| Stopped by operator/planner | `stop_room` or `POST .../abort` called | `goalStatus: "cancelled"`, room + transcript preserved |
| Room limit reached | More than `PIPELINE_MAX_ROOMS` rooms | `spawn_room` rejected with `429` |

---

*Last updated: 2026-06-22*
