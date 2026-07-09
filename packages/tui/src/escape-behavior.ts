// F7 (knownissues.md): pure decision logic for CommandLine's Esc key, pulled
// out for testability — this package tests behavior as small pure functions
// (see roster-stats.ts, preset-picker.ts) rather than rendering components
// with simulated keypresses.
//
// An empty input line with no pending image has nothing for Esc to clear —
// that keystroke was previously a no-op. Repurposed, only in that specific
// state, to abort a running turn: one keystroke, parity with the WebUI's
// always-visible Stop button, without overloading Ctrl+C (which terminals
// treat as "kill the process", not "cancel the current action").

/** Whether an Esc press should abort the running turn instead of its normal
 *  clear-the-input behavior. True only when there is genuinely nothing to
 *  clear (empty text, no pending image) AND a turn is actually running AND
 *  an abort handler was supplied. */
export function shouldAbortOnEscape(opts: {
  turnActive: boolean | undefined
  hasOnAbort: boolean
  value: string
  pendingImageCount: number | undefined
}): boolean {
  return !!opts.turnActive && opts.hasOnAbort && opts.value === "" && (opts.pendingImageCount ?? 0) === 0
}
