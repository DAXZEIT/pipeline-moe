/**
 * Pure decision logic for the ask_user answer picker (QCM) — the closed-choice
 * companion of the slash palette. Extracted from CommandLine for the same
 * reason as escape-behavior.ts: the component wiring is Ink-bound, but WHICH
 * key does WHAT while a picker is showing is a pure function worth pinning
 * with tests.
 *
 * Interaction contract (mirrors the palette precedent — "the palette owns ↑/↓
 * only while it's open"):
 * - The picker shows only while the room is paused on a question WITH options,
 *   the input line is empty, and the user hasn't dismissed it.
 * - ↑/↓ move the highlight; ⏎ answers with the highlighted option.
 * - Digits 1-N answer instantly (the QCM fast path).
 * - Esc dismisses the picker for this question — free-typing space, and the
 *   mouse wheel (which sends ↑/↓) gets the transcript back.
 * - Typing any other character falls through to the normal input: a free-text
 *   answer is always available, no mode to leave.
 */

export interface PickerState {
  /** Options offered with the paused question, or null/empty when none. */
  options: string[] | null
  /** Current input line value — a non-empty line means free-text mode. */
  value: string
  /** User pressed Esc on this question's picker. */
  dismissed: boolean
}

/** Whether the picker is visible (and therefore owns ↑/↓/⏎/digits). */
export function pickerVisible(s: PickerState): boolean {
  return !!s.options && s.options.length > 0 && s.value === "" && !s.dismissed
}

export type PickerAction =
  | { kind: "move"; delta: 1 | -1 }
  | { kind: "submit"; index: number }
  | { kind: "dismiss" }
  | { kind: "passthrough" }

/** Decide what a keypress does while the picker is visible. `highlighted` is
 *  the current highlight index; digit keys resolve directly to their option. */
export function pickerKeyAction(
  input: string,
  key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean },
  optionCount: number,
  highlighted: number,
): PickerAction {
  if (key.escape) return { kind: "dismiss" }
  if (key.upArrow) return { kind: "move", delta: -1 }
  if (key.downArrow) return { kind: "move", delta: 1 }
  if (key.return) return { kind: "submit", index: highlighted }
  if (input.length === 1 && input >= "1" && input <= "9") {
    const idx = Number(input) - 1
    if (idx < optionCount) return { kind: "submit", index: idx }
  }
  return { kind: "passthrough" }
}
