// Runtime configuration, read from environment (with .env support via tsx is
// not automatic — we read process.env directly; use `node --env-file=.env` or
// export vars). Defaults are chosen to work out of the box on the dax stack.

import { resolve } from "node:path"

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
  thinkingLevel: (process.env.PIPELINE_THINKING ?? "medium") as
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh",
  /** Allowed CORS origins, comma-separated. Defaults to local dev servers. */
  corsOrigins: process.env.PIPELINE_CORS_ORIGINS
    ? process.env.PIPELINE_CORS_ORIGINS.split(",").map((s) => s.trim())
    : ["http://localhost:5310", "http://localhost:5300"],
}
