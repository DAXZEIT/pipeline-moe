#!/usr/bin/env node
// pmoe-ink — the previous Ink client, kept reachable for one release after the
// Phase 6 flip (2026-07-27) as the escape hatch while the pi-tui client
// (`pmoe`) does its week of real use. Deleted with src/components/ once the
// week has spoken. See docs/tui-pitui-migration-plan.md.

import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
// tsx discovers tsconfig from the cwd, not from the imported file — pin it to
// the package's own tsconfig so `jsx: react-jsx` applies wherever it runs.
process.env.TSX_TSCONFIG_PATH ??= resolve(root, "tsconfig.json")
const { register } = await import("tsx/esm/api")
register()
await import(resolve(root, "src", "cli.tsx"))
