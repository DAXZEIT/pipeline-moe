// Runtime configuration, read from environment. A .env in the working
// directory is loaded automatically (shell env takes precedence, same
// semantics as node --env-file). Skipped under vitest so tests stay hermetic.
// Defaults are chosen to work out of the box on a local llama-server stack.

import { resolve } from "node:path"

if (!process.env.VITEST) {
  try {
    process.loadEnvFile(resolve(process.cwd(), ".env"))
  } catch {
    // no .env — fine, env vars and defaults apply
  }
}

export const config = {
  port: Number(process.env.PORT ?? 5300),
  workspaceDir: process.env.WORKSPACE_DIR ?? process.cwd(),
  /** Where group conversations are persisted as JSON (one file per discussion). */
  sessionsDir: resolve(process.env.SESSIONS_DIR ?? resolve(process.cwd(), "sessions")),
  /** Where pi's plan tool persists plan files (`.pi/plans/*.md` — JSON header +
   *  optional markdown body, despite the extension). Read-only from this
   *  process's perspective: used for plan-aware fallback routing.
   *  Under vitest, defaults to a path that doesn't exist so the existing test
   *  suite doesn't accidentally couple to whatever real plans happen to be on
   *  disk on the machine running the tests (plan-aware routing hits this on
   *  every no-mention turn end, which most fallback-routing tests exercise).
   *  Tests that specifically want plan-aware routing behavior either call
   *  `findActivePlan()` with an explicit directory, or mutate `config.plansDir`
   *  for the duration of one test (same idiom as `config.sessionsDir` in
   *  room-manager.test.ts). */
  plansDir: resolve(
    process.env.PIPELINE_PLANS_DIR ??
      (process.env.VITEST ? resolve(process.cwd(), ".pi/__no-plans-dir-in-tests__") : resolve(process.cwd(), ".pi/plans")),
  ),
  /** Persist each agent's pi session to disk (context survives restarts and
   *  room resume). Set PIPELINE_EPHEMERAL_AGENTS=1 for the old in-memory
   *  behavior where agents catch up by replaying the room transcript. */
  persistAgentSessions: !/^(1|true|yes)$/i.test(process.env.PIPELINE_EPHEMERAL_AGENTS ?? ""),
  /** "provider/id" override; empty means use pi's default model resolution. */
  modelOverride: process.env.PIPELINE_MODEL ?? "",
  /** This stack is local-only by policy. Cloud models are hidden from the model
   *  picker and rejected on personas unless this is explicitly turned on. */
  allowCloud: /^(1|true|yes)$/i.test(process.env.PIPELINE_ALLOW_CLOUD ?? ""),
  thinkingLevel: (process.env.PIPELINE_THINKING ?? "medium") as
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh",
  /** Hard cap on the total number of concurrent rooms, default room included.
   *  Prevents a planner (or a runaway goal-eval loop) from spawning sub-rooms
   *  without bound — every local room contends for the single llama-server slot.
   *  provisionRoom rejects spawns past this. Set PIPELINE_MAX_ROOMS to tune. */
  maxRooms: Math.max(1, Number(process.env.PIPELINE_MAX_ROOMS ?? 8) || 8),
  /** Allowed CORS origins, comma-separated. Defaults to local dev servers. */
  corsOrigins: process.env.PIPELINE_CORS_ORIGINS
    ? process.env.PIPELINE_CORS_ORIGINS.split(",").map((s) => s.trim())
    : ["http://localhost:5310", "http://localhost:5300"],
}
