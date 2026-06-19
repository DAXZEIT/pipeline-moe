# Focus Mode — Architectural Sketch

> Stage 1 of the sub-chatroom concept. Isolate a subset of agents into a side transcript, return a structured summary to the main room. No parallelism — sequential but context-isolated.

**Status:** Shelf design — not active. Trigger: when compact-after-the-fact stops being sufficient.

---

## Problem

Intense agent loops (builder + tester iterating on a bug for 15-30 turns) pollute the main transcript. Every agent in the main room replays all that noise. Compact mitigates after the fact, but the context window already paid for the damage during the loop.

## Shape

```
[Main Room — Room A]
  Roster: planner, builder, tester, auditor
  Command: /focus builder tester "fix type error in server.ts"
  
  → Fork: builder + tester move to Room B (side transcript)
  → Main room gets: "builder and tester are in focus mode: fix type error in server.ts"
  → Main room continues: planner can plan, user can type, auditor can review
  → Focus room: builder and tester iterate freely, isolated transcript
  
  Command: /unfocus
  → Focus room collapses
  → Structured summary merges back into main room transcript
  → builder and tester rejoin main roster with normal state
```

## The Four Structural Questions

### 1. Partial Roster Fork

**Current state:** `Room.runAgent()` picks one agent from the roster, runs it in the current conversation. Conversation is room-level, not agent-level. `AgentSession` lives per-participant-per-conversation.

**What focus mode needs:** A subset of agents operates in a parallel transcript. Their main-room selves are temporarily inactive.

**Approach:** Create temporary `Participant` clones for the forked agents.

- Each clone shares the same `Persona` (model, system prompt, tools) but gets a fresh `AgentSession` with its own context window and message history.
- The original `Participant` in the main room is marked as "in focus mode" — excluded from `runAgent()` selection, shown as unavailable in UI.
- When focus ends, the clone's state (file changes, tool results) is absorbed back into the original. The clone's session history is discarded — only the summary persists.

**Key constraint:** The clone must be able to call tools (read, write, edit, bash) normally. Tool effects are real — they modify the workspace. The work receipt tracks them. No sandboxing needed for Stage 1.

**Unresolved:** What happens to the original participant's session history during the fork? Two options:
- **Frozen:** The original session stays as-is, paused. When focus ends, the summary is appended as a single message and the session resumes from there. (Simpler, cleaner.)
- **Gap message:** A placeholder message is inserted during the fork: "[builder and tester are in focus mode on X]" so the transcript has continuity. When focus ends, the placeholder is replaced with the summary. (Better UX, slightly more complex.)

Recommendation: Start with frozen. Gap messages can be added if the UX feels jarring.

### 2. Termination

**Stage 1 is manual.** No auto-detection of completion.

**Command surface:**

- `/focus <agents> "<task>"` — forks the named agents into a focus room with the given task description.
- `/unfocus` — collapses the active focus room, generates summary, merges back.

**Who can call `/unfocus`?** The user (via chat), or any agent in the focus room (if we want agents to be able to declare themselves done). Start with user-only. Agent-initiated unfocus is a Stage 2 consideration.

**Edge cases:**
- What if the user types `/focus` while a focus room is already active? Reject with "focus room already active."
- What if the user tries to fork an agent that's already in the focus room? Reject.
- What if the user tries to fork all agents? Allow, but the main room becomes effectively empty — just a placeholder.

### 3. Merge-Back Summary

The summary is the bridge between the isolated transcript and the main room. It must be structured, not a freeform text blob.

**Proposed structure:**

```markdown
## Focus Summary: <task description>

**Duration:** N turns, M tool calls
**Outcome:** <brief result — success / partial / blocked>

### Files Modified
- `src/foo.ts` — changed X
- `src/bar.ts` — added Y

### Tests
- 42/42 passing (or: 2 failures: ...)

### Notes
- <any context the main room needs to know>
- <open questions or blockers>
```

**Who generates it?** Two options:
- **One of the focus agents** writes it before unfocus (e.g., the last agent to act in the focus room). Problem: the agent may not have the full picture.
- **A compaction pass** on the focus transcript, triggered by `/unfocus`. The focus transcript is fed through a summarization pass (could use the same model, or a cheaper one) to produce the summary. This is more reliable but adds latency.

Recommendation: Start with the agent approach — the last agent in the focus room appends a summary section to the transcript. When `/unfocus` runs, it extracts that summary and merges it. If the summary quality is poor, switch to the compaction approach.

**Where does the summary land in the main transcript?** As a single message attributed to the focus group: `[builder + tester focus summary]` with the structured content. The main room's agents see it as context for their next turns.

### 4. SSE Multiplexing

**Current state:** `SseHub` broadcasts events to all connected clients. No room scoping — one room, one stream.

**What focus mode needs:** The frontend receives events from both the main room and the focus room simultaneously.

**Options:**

1. **Scope events with `roomId`:** Every SSE event gets a `roomId` field. Frontend renders two panels (main room + focus room) side by side. Full visibility into the focus room's activity.

2. **Black box (status only):** Focus room events are not streamed to the frontend at all. The main room shows a status indicator: "builder and tester in focus mode — 5 turns" that updates periodically. Only the summary appears when focus ends.

3. **Merged stream with prefix:** Focus room events are injected into the main SSE stream with a visual prefix (e.g., `[focus]`). Single panel, but visually distinct.

**Recommendation:** Option 2 (black box) for Stage 1. Rationale:
- It's the simplest — no SSE changes needed. The focus room runs internally, the main room only knows about it through status events.
- It matches the core value proposition: the main room should *not* see the noise. If the frontend renders the focus room's turns, it defeats the isolation purpose.
- It can be upgraded to Option 1 (scoped events + dual panels) in Stage 2 if users want visibility into focus room activity.

**Implementation note:** The main room needs periodic status updates from the focus room. A lightweight mechanism: the focus room emits a `focus:status` event (turn count, current agent) on each turn. The frontend displays this as a small indicator next to the forked agents' names.

---

## Dependencies

- Existing `Room.newConversation()` and `switchConversation()` — provides the transcript forking mechanism.
- Existing `Participant` cloning — needs a shallow clone method (same persona, fresh session).
- Existing work receipt system — already tracks file changes and tool calls, can be harvested for the summary.

## What's NOT in Stage 1

- Auto-termination (agents declaring completion).
- Parallel sub-rooms (multiple focus rooms active simultaneously).
- Cloud agent parallelism inside focus rooms.
- Dynamic roster allocation (planner spawning focus rooms automatically).
- UI panel for the focus room's live transcript.

These are Stage 2+ considerations.
