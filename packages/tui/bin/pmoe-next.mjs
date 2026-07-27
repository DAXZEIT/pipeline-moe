#!/usr/bin/env node
// pmoe-next — now an alias of `pmoe`: the pi-tui client became the default at
// the Phase 6 flip (2026-07-27). Kept for the muscle memory of the migration
// weeks; dies with `pmoe-ink` once the post-flip release ships.

import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
process.env.TSX_TSCONFIG_PATH ??= resolve(root, "tsconfig.json")
const { register } = await import("tsx/esm/api")
register()
await import(resolve(root, "src", "next", "main.ts"))
