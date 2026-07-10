// Declarative handoff gates — the pure logic that decides whether an agent's
// handoff is allowed given what it touched this turn. The pipeline's review
// norm ("everything under src/ passes through the auditor before closure")
// used to live only in prose — persona prompts and the planner's memory — so
// the builder could hand straight to the tester and nothing in the core
// objected (observed live, session mre5zpel round 1). A gate turns that norm
// into an invariant: while `from` has touched matching paths in its CURRENT
// turn, its handoff must target `via`. Enforcement is a correctable tool
// error (no terminate), so the model re-routes itself in the same turn — the
// same recovery principle that already works for invalid handoff targets.
//
// Deliberate limits (documented, not accidental):
// - Path detection reads executed write/edit tool calls (status "ok"), like
//   receiptFromActivity. Files changed as a side effect of `bash` (scripts,
//   git operations) do NOT arm a gate.
// - The gate looks at the current turn only. A builder turn that edits src/
//   and routes to the auditor satisfies it; the builder's NEXT turn with no
//   edits hands off freely — which is exactly the norm's shape.
// - A gate whose `via` is not an active participant is skipped entirely: an
//   absent or crashed reviewer must not deadlock the room (the auditor 403'd
//   live on 2026-07-10; a team routes around a dead gate, it doesn't hang).

import { isAbsolute, relative, sep } from "node:path"
import type { HandoffGate, ToolActivity } from "./types.js"

/** File-mutating built-in tools whose args carry a target path — mirrors
 *  receipts.ts (kept separate: receipts marks every path "modified", gates
 *  only care that SOMETHING matching was touched). */
const FILE_WRITE_TOOLS = new Set(["write", "edit"])

// Compile one glob (`*`, `**`, `?`) to an anchored RegExp over `/`-separated
// workspace-relative paths. `src/**` matches everything under src/ at any
// depth; `*.md` matches root-level markdown only; a pattern starting with a
// `**` segment (e.g. `**/x.test.ts`) matches at any depth. No brace/extglob
// support — the preset format stays boring. (Line comments on purpose: glob
// examples contain `*` followed by `/`, which terminates a block comment.)
export function globToRegExp(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` may match zero directories; a trailing/bare `**` matches everything.
        if (glob[i + 2] === "/") {
          re += "(?:[^/]+/)*"
          i += 2
        } else {
          re += ".*"
          i += 1
        }
      } else {
        re += "[^/]*"
      }
    } else if (c === "?") {
      re += "[^/]"
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    }
  }
  return new RegExp(`^${re}$`)
}

/** Workspace-relative, `/`-separated paths touched by executed write/edit
 *  calls in this activity. Absolute paths inside the workspace are relativized;
 *  absolute paths OUTSIDE it are kept verbatim (a gate can still name them). */
export function touchedPaths(activity: ToolActivity[], workspaceDir: string): string[] {
  const out = new Set<string>()
  for (const a of activity) {
    if (a.status !== "ok" || !FILE_WRITE_TOOLS.has(a.toolName)) continue
    if (!a.args || typeof a.args !== "object") continue
    const args = a.args as Record<string, unknown>
    for (const key of ["file_path", "path", "filePath"]) {
      const v = args[key]
      if (typeof v !== "string" || !v.trim()) continue
      let p = v.trim()
      if (isAbsolute(p)) {
        const rel = relative(workspaceDir, p)
        if (rel && !rel.startsWith("..") && !isAbsolute(rel)) p = rel
      }
      out.add(p.split(sep).join("/"))
      break
    }
  }
  return [...out].sort()
}

/** Decide whether `from` handing off to `to` violates a gate.
 *  Returns a correctable error message (for the tool's error result) when
 *  blocked, or null when the handoff may proceed.
 *
 *  Rules, in order:
 *  - Only gates with `gate.from === from`, an active `via`, and `via !== from`
 *    participate.
 *  - A gate is ARMED when it has no `when` patterns, or when this turn touched
 *    a matching path.
 *  - If no gate is armed → allowed.
 *  - If `to` is the `via` of ANY armed gate → allowed (satisfying one armed
 *    gate wins; two armed gates demanding different reviewers must not
 *    deadlock the agent between them).
 *  - Otherwise → blocked, naming every armed gate's required target. */
export function checkHandoffGates(
  gates: HandoffGate[],
  from: string,
  to: string,
  activity: ToolActivity[],
  workspaceDir: string,
  activeIds: string[],
): string | null {
  const applicable = gates.filter(
    (g) => g.from === from && g.via !== from && activeIds.includes(g.via),
  )
  if (applicable.length === 0) return null

  const touched = touchedPaths(activity, workspaceDir)
  const armed: Array<{ gate: HandoffGate; matched: string[] }> = []
  for (const gate of applicable) {
    if (!gate.when || gate.when.length === 0) {
      armed.push({ gate, matched: [] })
      continue
    }
    const regexps = gate.when.map(globToRegExp)
    const matched = touched.filter((p) => regexps.some((re) => re.test(p)))
    if (matched.length > 0) armed.push({ gate, matched })
  }
  if (armed.length === 0) return null
  if (armed.some((a) => a.gate.via === to)) return null

  const first = armed[0]
  const vias = [...new Set(armed.map((a) => a.gate.via))]
  const evidence =
    first.matched.length > 0
      ? `you modified ${summarizePaths(first.matched)} this turn`
      : `a review gate applies to every handoff you make`
  const alternatives = vias.map((v) => `handoff(to: "${v}")`).join(" or ")
  return (
    `handoff to "${to}" blocked by a review gate: ${evidence}, and this room requires ` +
    `that work to pass through @${vias.join(" or @")} before anyone else. ` +
    `Call ${alternatives} instead. If you believe the gate is wrong here, say so in ` +
    `your reply — the human can adjust the room's gates.`
  )
}

/** First few paths, with a count for the rest — error messages stay one line. */
function summarizePaths(paths: string[]): string {
  const shown = paths.slice(0, 3).join(", ")
  return paths.length > 3 ? `${shown} (+${paths.length - 3} more)` : shown
}
