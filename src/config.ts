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
  /** "provider/id" override; empty means use pi's default model resolution. */
  modelOverride: process.env.PIPELINE_MODEL ?? "",
  /** This stack is local-only by policy. Cloud models are hidden from the model
   *  picker and rejected on personas unless this is explicitly turned on. */
  allowCloud: /^(1|true|yes)$/i.test(process.env.PIPELINE_ALLOW_CLOUD ?? ""),
  /** Circuit breaker (repetition + tool-loop detection). Defaults ON. Set
   *  PIPELINE_CIRCUIT_BREAKER=0 to disable — useful with cloud models that
   *  legitimately repeat output, where the breaker stops loops for no reason. */
  circuitBreaker: !/^(0|false|no)$/i.test(process.env.PIPELINE_CIRCUIT_BREAKER ?? "true"),
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
