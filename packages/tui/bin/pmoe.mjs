#!/usr/bin/env node
// pmoe — pipeline-moe terminal client, on @earendil-works/pi-tui since the
// Phase 6 flip (2026-07-27). The previous Ink client stays reachable as
// `pmoe-ink` for one release; see docs/tui-pitui-migration-plan.md.
//
// The TUI is TypeScript run directly through tsx (no build step); this wrapper
// registers the loader and hands over to src/next/main.ts, which parses
// --server/--room/--stats.

import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
// tsx discovers tsconfig from the cwd, not from the imported file — pin it to
// the package's own tsconfig so it resolves wherever pmoe runs.
process.env.TSX_TSCONFIG_PATH ??= resolve(root, "tsconfig.json")
const { register } = await import("tsx/esm/api")
register()
await import(resolve(root, "src", "next", "main.ts"))
