/**
 * Prompt history for the command line (pi's Editor behavior, v1). ↑/↓ recall
 * past submissions while a draft exists; the in-progress draft is parked when
 * history navigation starts and restored when ↓ walks past the newest entry.
 * Pure state-in/state-out so the arbitration stays testable — the component
 * just holds the state in a ref.
 *
 * Keyboard arbitration note: on an EMPTY input the arrows keep scrolling the
 * transcript — that's what the mouse wheel emits under alternate-scroll mode
 * (1007), and idle wheel-reading is the dominant empty-line case. The cost is
 * that recalling the last prompt needs a first keystroke. The real fix is the
 * native-scrollback architecture (docs/tui-lessons-from-pi.md #1), which
 * frees the arrows entirely.
 */

export interface PromptHistory {
  entries: string[]
  /** -1 = live draft; otherwise an index into entries. */
  index: number
  /** The draft parked when navigation started. */
  draft: string
}

export function newPromptHistory(): PromptHistory {
  return { entries: [], index: -1, draft: "" }
}

const CAP = 100

/** Record a submission: consecutive duplicates collapse, list stays capped,
 *  navigation state resets. Empty strings are ignored. */
export function pushPrompt(h: PromptHistory, text: string): void {
  if (text && h.entries[h.entries.length - 1] !== text) {
    h.entries.push(text)
    if (h.entries.length > CAP) h.entries.splice(0, h.entries.length - CAP)
  }
  h.index = -1
  h.draft = ""
}

/** ↑ — step to the previous entry (parking the draft on first entry into
 *  history). Returns the text to show, or null when there's nothing older. */
export function recallPrev(h: PromptHistory, currentValue: string): string | null {
  if (h.entries.length === 0) return null
  if (h.index === -1) {
    h.draft = currentValue
    h.index = h.entries.length - 1
  } else if (h.index > 0) {
    h.index -= 1
  } else {
    return null
  }
  return h.entries[h.index]
}

/** ↓ — step toward the present; walking past the newest entry restores the
 *  parked draft. Returns the text to show, or null when not navigating. */
export function recallNext(h: PromptHistory): string | null {
  if (h.index === -1) return null
  if (h.index < h.entries.length - 1) {
    h.index += 1
    return h.entries[h.index]
  }
  h.index = -1
  return h.draft
}
