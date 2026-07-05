#!/usr/bin/env node
// pmoe — pipeline-moe terminal client. The TUI is TypeScript/JSX run directly
// through tsx (no build step); this wrapper registers the loader and hands
// over to src/cli.tsx, which parses --server/--room.

import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
// tsx discovers tsconfig from the cwd, not from the imported file — pin it to
// the package's own tsconfig so `jsx: react-jsx` applies wherever pmoe runs.
process.env.TSX_TSCONFIG_PATH ??= resolve(root, "tsconfig.json")
const { register } = await import("tsx/esm/api")
register()
await import(resolve(root, "src", "cli.tsx"))
