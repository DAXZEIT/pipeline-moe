// Plan-aware fallback routing: when an agent finishes a turn without
// @-mentioning anyone, consult the active plan (if any) and route to the
// owner of the next incomplete step instead of the generic fallback agent.
//
// ── Ground-truth contract for `.pi/plans/*.md` (verified empirically 2026-07-08,
//    PLAN-c1874a35 step 1 — do not re-derive this from the plan tool's schema,
//    the on-disk format differs from what `plan get` returns) ──────────────
//
// 1. NOT pure JSON despite the `.md` extension. Each file is a top-level JSON
//    object (id *without* the "PLAN-" prefix, title, status, created_at,
//    assigned_to_session?, steps[]) followed — when a body exists — by RAW
//    markdown (`## Goal`, etc.), unescaped, directly after the closing `}`.
//    `JSON.parse(readFileSync(path, "utf8"))` fails on the large majority of
//    real plan files (verified: 69/72 in this repo fail with "Extra data").
//    The `body` field the `plan` tool returns is synthesized by the tool at
//    read time — it is not the on-disk representation. We only need
//    id/status/assigned_to_session/steps for routing, so we never need the
//    markdown body: extract just the JSON header via brace-depth scanning
//    (respecting quoted strings and escapes) and parse only that substring.
//
// 2. `claim` does NOT set `status` to "active" — verified by creating a
//    disposable plan, claiming it, and reading the file back: only
//    `assigned_to_session` changes, `status` stays whatever it was (usually
//    "draft"). "active" is a status only ever reached via an explicit
//    `update` call, and it's used inconsistently across the plan history:
//    of 72 real plan files, 47 are "completed" (reliable — this is set
//    consistently at closure), while the remaining ~24 oscillate between
//    "draft" and "active" with no correlation to whether the work is still
//    in flight (several "active" plans are demonstrably shipped and
//    forgotten). `assigned_to_session` is similarly unreliable as a
//    "currently being worked" signal — most non-completed plans don't have
//    one, and at least one with an assignment is an orphaned claim from
//    long-shipped work.
//
// 3. Consequence: selection does NOT filter on `status === "active"`. It
//    filters OUT `completed`/`archived` (the one reliably-maintained
//    signal) and then picks the most-recently-modified file (mtime) among
//    survivors. mtime is the PRIMARY signal here, not a tie-breaker.
//
// 4. Some files under `.pi/plans/` aren't plan-tool output at all (e.g.
//    `pi-api-audit.md` is a hand-written pure-markdown tracking doc with no
//    JSON header). Parsing must be fully defensive: any failure on any file
//    silently skips that file, never throws.

import { readFile, readdir, stat } from "node:fs/promises"
import { config } from "./config.js"

export interface PlanStep {
  id: number
  text: string
  done: boolean
}

export interface ParsedPlan {
  id: string
  title: string
  status: string
  assigned_to_session?: string
  steps: PlanStep[]
}

const OWNER_RE = /^\[([a-z][a-z0-9_-]*)\]\s*/

/** Extract the leading JSON object from raw plan-file content, ignoring any
 *  markdown that follows. Returns null if no balanced top-level object is
 *  found (malformed / non-plan file). Brace-depth scan respects quoted
 *  strings and backslash escapes so braces inside step text don't confuse it. */
export function extractJsonHeader(content: string): string | null {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === "\\") {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === "{") {
      depth++
    } else if (ch === "}") {
      depth--
      if (depth === 0) {
        return content.slice(0, i + 1)
      }
    }
  }
  return null
}

/** Parse one plan file's content into a ParsedPlan, or null on any failure
 *  (malformed JSON, missing required fields, not a plan file at all). Never
 *  throws. */
export function parsePlanContent(content: string): ParsedPlan | null {
  const header = extractJsonHeader(content)
  if (!header) return null
  try {
    const obj = JSON.parse(header)
    if (
      typeof obj !== "object" ||
      obj === null ||
      typeof obj.id !== "string" ||
      typeof obj.status !== "string" ||
      !Array.isArray(obj.steps)
    ) {
      return null
    }
    const steps: PlanStep[] = obj.steps
      .filter(
        (s: unknown): s is PlanStep =>
          typeof s === "object" &&
          s !== null &&
          typeof (s as Record<string, unknown>).id === "number" &&
          typeof (s as Record<string, unknown>).text === "string" &&
          typeof (s as Record<string, unknown>).done === "boolean",
      )
      .map((s: PlanStep) => ({ id: s.id, text: s.text, done: s.done }))
    return {
      id: obj.id,
      title: typeof obj.title === "string" ? obj.title : "",
      status: obj.status,
      assigned_to_session: typeof obj.assigned_to_session === "string" ? obj.assigned_to_session : undefined,
      steps,
    }
  } catch {
    return null
  }
}

/** Find the most recently modified non-completed/archived plan in
 *  `config.plansDir`. Returns null if the directory can't be read or no
 *  eligible plan exists. Never throws.
 *
 *  Perf note: this runs on every no-mention turn end (fallback routing is a
 *  common path), so it stats all candidates first (cheap) and sorts by mtime
 *  descending, then reads+parses content in that order, returning at the
 *  FIRST eligible (non-completed/archived, successfully parsed) match. In
 *  the common case — the plan currently being worked is also the most
 *  recently touched file — this means reading one file, not scanning the
 *  whole directory. */
export async function findActivePlan(plansDir: string = config.plansDir): Promise<ParsedPlan | null> {
  let entries: string[]
  try {
    entries = (await readdir(plansDir)).filter((f) => f.endsWith(".md"))
  } catch {
    return null
  }

  const stats: Array<{ path: string; mtimeMs: number }> = []
  await Promise.all(
    entries.map(async (entry) => {
      const path = `${plansDir}/${entry}`
      try {
        const s = await stat(path)
        stats.push({ path, mtimeMs: s.mtimeMs })
      } catch {
        // Vanished between readdir and stat, or unreadable — skip.
      }
    }),
  )
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs)

  for (const { path } of stats) {
    let content: string
    try {
      content = await readFile(path, "utf8")
    } catch {
      continue
    }
    const plan = parsePlanContent(content)
    if (!plan) continue
    if (plan.status === "completed" || plan.status === "archived") continue
    return plan
  }
  return null
}

/** Read and parse a single plan by its bare id (`<id>.md` in plansDir), the
 *  adoption-scoped counterpart of findActivePlan. Returns null if the file is
 *  missing/unparseable or the plan is completed/archived. Never throws.
 *
 *  This is what plan-aware routing consults now: a room routes ONLY by the plan
 *  it has actually adopted (see planAdoptionId), never "whatever .md was touched
 *  most recently". That mtime heuristic hijacked a conversational planner reply
 *  into a stale, unrelated plan whose next step happened to be owned by tester
 *  (observed live 2026-07-09: tester began killing backend processes from a
 *  days-old plan the room never worked). */
export async function findPlanById(plansDir: string, id: string): Promise<ParsedPlan | null> {
  let content: string
  try {
    content = await readFile(`${plansDir}/${id}.md`, "utf8")
  } catch {
    return null
  }
  const plan = parsePlanContent(content)
  if (!plan) return null
  if (plan.status === "completed" || plan.status === "archived") return null
  return plan
}

/** The structural subset of a tool-call record we need to decide adoption —
 *  kept minimal so this module stays decoupled from the app's ToolActivity. */
export interface PlanToolCall {
  toolName: string
  status: string
  args?: unknown
  result?: string
}

const PLAN_ID_RE = /PLAN-([0-9a-f]+)/i
/** Plan tool actions that only READ. They must never adopt a plan — the bug
 *  was a `plan list` surfacing a stale plan and that plan then driving routing.
 *  Anything not in this set (create/claim/update/complete/…) mutates and so
 *  signals the room is actively working that plan. */
const READ_ONLY_PLAN_ACTIONS = new Set(["list", "get", "read", "show", "view"])

/** Strip the display-only "PLAN-" prefix so ids compare against on-disk file
 *  basenames and ParsedPlan.id (both bare). */
function bareId(id: string): string {
  return id.replace(/^PLAN-/i, "")
}

/** Scan one finished turn's tool activity for a plan the agent actively worked
 *  (a mutating `plan` call — create/claim/update/…) and return that plan's bare
 *  id: the plan THIS room should now route by. Read-only plan calls never adopt.
 *  The last mutated plan in the turn wins. Returns null if no plan was mutated
 *  or the id can't be recovered. Never throws. */
export function planAdoptionId(activity: readonly PlanToolCall[]): string | null {
  let adopted: string | null = null
  for (const a of activity) {
    if (a.toolName !== "plan" || a.status !== "ok") continue
    const args = (a.args ?? {}) as Record<string, unknown>
    const action = typeof args.action === "string" ? args.action.toLowerCase() : ""
    if (READ_ONLY_PLAN_ACTIONS.has(action)) continue
    // id from args (claim/update/complete/…), else parsed from the result text
    // (create returns a fresh PLAN-xxxx and carries no id arg).
    const argId = typeof args.id === "string" ? args.id : null
    const resId = typeof a.result === "string" ? a.result.match(PLAN_ID_RE)?.[1] : null
    const id = argId ?? (resId ? `PLAN-${resId}` : null)
    if (id) adopted = bareId(id)
  }
  return adopted
}

/** Parse a leading `[agent-id]` owner prefix from step text. Returns null if
 *  the step has no owner prefix (legacy/unowned steps fall back to default
 *  routing). */
export function parseStepOwner(text: string): string | null {
  const m = OWNER_RE.exec(text)
  return m ? m[1] : null
}

/** The first incomplete step's owner, or null if there is no active plan,
 *  every step is done, or the next incomplete step has no owner prefix. */
export function nextStepOwner(plan: ParsedPlan | null): string | null {
  if (!plan) return null
  const next = plan.steps.find((s) => !s.done)
  if (!next) return null
  return parseStepOwner(next.text)
}
