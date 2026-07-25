import type { ToolActivity } from "./types.js"

/** Compact duration: 800ms → "0.8s", 8240 → "8.2s", 74s → "1m14s". */
export function fmtDuration(ms: number): string {
  if (ms < 60_000) {
    const s = ms / 1000
    return `${s.toFixed(s < 10 ? 1 : 0)}s`
  }
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`
}

/** Below this, a tool call took no time worth reading and its duration is not
 *  drawn at all.
 *
 *  Measured over every `durationMs` recorded so far (29 calls, 2026-07-25):
 *  min 1 ms, median 2 ms, max 15 ms — all of them local filesystem tools. pi
 *  prints `Took 0.0s` under each of those; a column of zeroes is not a
 *  measurement, it is decoration that makes the one slow call harder to spot.
 *  The number earns its space exactly when something WAS slow — a `bash`
 *  running a test suite, a network tool. */
export const SLOW_TOOL_MS = 1000

/** Total time for a run of tool calls, formatted — or `undefined` when it is
 *  unknown (pre-`durationMs` history) or too short to be worth the column. */
export function toolDuration(items: readonly ToolActivity[]): string | undefined {
  let total = 0
  let known = false
  for (const a of items) {
    if (a.durationMs == null) continue
    known = true
    total += a.durationMs
  }
  if (!known || total < SLOW_TOOL_MS) return undefined
  return fmtDuration(total)
}
