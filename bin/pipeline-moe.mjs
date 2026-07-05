#!/usr/bin/env node
// pipeline-moe CLI — `pipeline-moe serve` starts the server (API + web UI when
// a build is bundled). The stack runs TypeScript directly through tsx, so no
// build step is needed at install time.

import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { readFileSync } from "node:fs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cmd = process.argv[2] ?? "serve"

if (cmd === "--version" || cmd === "-v") {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"))
  console.log(pkg.version)
  process.exit(0)
}

if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(`pipeline-moe — local-first multi-agent chat room

Usage:
  pipeline-moe serve     Start the server (default; port 5300, PORT to change)
  pipeline-moe --version Print version

Configuration is read from the environment and a .env in the current
directory (see .env.example in the package). Requires a local model server
compatible with pi (e.g. llama-server on :5000) unless PIPELINE_ALLOW_CLOUD=1.
The terminal client lives in the same repo: packages/tui (bin: pmoe).`)
  process.exit(0)
}

if (cmd !== "serve") {
  console.error(`Unknown command: ${cmd} (try --help)`)
  process.exit(1)
}

const { register } = await import("tsx/esm/api")
register()
await import(resolve(root, "src", "server.ts"))
