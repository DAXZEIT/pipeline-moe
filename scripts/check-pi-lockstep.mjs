#!/usr/bin/env node
// Guard: every @earendil-works/pi-* dependency is pinned EXACT, to the SAME
// version, and the lockfile agrees with the manifest.
//
// Why this is mechanical and not a norm: the four pi packages share internal
// types and are released together, so a partial bump is not "slightly behind"
// — it is two copies of pi-ai's types in one tree, and the symptom surfaces as
// an unrelated type error or a runtime shape mismatch far from the bump. The
// release checklist already says "bump the four together"; a checklist is a
// norm, and a norm is what a tired human or a confident agent skips. A caret
// on any of the four would also let `npm ci` drift them apart with no diff.
//
// Runs standalone (`node scripts/check-pi-lockstep.mjs`) — no install needed,
// so it is usable as a pre-release check, not just in CI.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (p) => JSON.parse(readFileSync(join(repoRoot, p), "utf8"))

const SCOPE = "@earendil-works/"
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const pkg = read("package.json")
const deps = { ...pkg.dependencies, ...pkg.devDependencies }
const pi = Object.entries(deps).filter(([name]) => name.startsWith(SCOPE))

const errors = []

if (pi.length === 0) {
  errors.push(`no ${SCOPE}* dependency found in package.json — has the scope been renamed?`)
}

// 1. Every spec is an exact version (a caret would let `npm ci` drift them).
for (const [name, spec] of pi) {
  if (!EXACT.test(spec)) {
    errors.push(`${name} is "${spec}" — must be an exact version, no range operator`)
  }
}

// 2. All four agree.
const versions = [...new Set(pi.map(([, spec]) => spec))]
if (versions.length > 1) {
  const detail = pi.map(([name, spec]) => `  ${name}: ${spec}`).join("\n")
  errors.push(`${SCOPE}* versions are out of lockstep (${versions.join(", ")}):\n${detail}`)
}

// 3. The lockfile resolves what the manifest asks for. A stale lock is the
//    failure mode `npm ci` reproduces silently on every machine.
let lock
try {
  lock = read("package-lock.json")
} catch (err) {
  errors.push(`package-lock.json unreadable: ${err.message}`)
}
if (lock?.packages) {
  for (const [name, spec] of pi) {
    const entry = lock.packages[`node_modules/${name}`]
    if (!entry) {
      errors.push(`${name} is in package.json but absent from package-lock.json — run npm install`)
    } else if (EXACT.test(spec) && entry.version !== spec) {
      errors.push(`${name}: package.json pins ${spec}, lockfile resolves ${entry.version}`)
    }
  }
}

if (errors.length > 0) {
  for (const e of errors) {
    // GitHub annotation when running in Actions; a plain line locally.
    console.error(process.env.GITHUB_ACTIONS ? `::error::${e}` : `error: ${e}`)
  }
  process.exit(1)
}

console.log(`${SCOPE}* pinned in lockstep at ${versions[0]} (${pi.length} packages, lockfile agrees)`)
