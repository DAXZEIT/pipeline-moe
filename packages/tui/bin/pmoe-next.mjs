#!/usr/bin/env node
// pmoe-next — the pi-tui client, shipped alongside `pmoe` (Ink) until it
// reaches parity. Same wrapper shape as pmoe.mjs: no build step, tsx loader,
// tsconfig pinned to the package's own so it resolves wherever pmoe-next runs.
//
// Both bins drive the same @pipeline-moe/client-core and render the same
// src/transcript-lines.ts. See docs/tui-pitui-migration-plan.md.

import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
process.env.TSX_TSCONFIG_PATH ??= resolve(root, "tsconfig.json")
const { register } = await import("tsx/esm/api")
register()
await import(resolve(root, "src", "next", "main.ts"))
