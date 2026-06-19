# Changelog

## [Unreleased] — 2026-06-19

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
