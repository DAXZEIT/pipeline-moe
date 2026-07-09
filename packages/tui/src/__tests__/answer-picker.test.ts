import { describe, expect, test } from "vitest"
import { pickerKeyAction, pickerVisible } from "../answer-picker"

// The QCM answer picker: pure key-decision logic for answering an ask_user
// question that carries closed options. Mirrors the slash palette's contract —
// the picker owns ↑/↓/⏎/digits only while visible; anything else falls
// through to the normal input (free text is always available).

describe("pickerVisible", () => {
  test("visible only with options, an empty input line, and no dismissal", () => {
    expect(pickerVisible({ options: ["a", "b"], value: "", dismissed: false })).toBe(true)
    expect(pickerVisible({ options: null, value: "", dismissed: false })).toBe(false)
    expect(pickerVisible({ options: [], value: "", dismissed: false })).toBe(false)
    expect(pickerVisible({ options: ["a"], value: "typing…", dismissed: false })).toBe(false)
    expect(pickerVisible({ options: ["a"], value: "", dismissed: true })).toBe(false)
  })
})

describe("pickerKeyAction", () => {
  const keys = (over: Record<string, boolean> = {}) => ({ ...over })

  test("arrows move the highlight, Enter submits it, Esc dismisses", () => {
    expect(pickerKeyAction("", keys({ upArrow: true }), 3, 1)).toEqual({ kind: "move", delta: -1 })
    expect(pickerKeyAction("", keys({ downArrow: true }), 3, 1)).toEqual({ kind: "move", delta: 1 })
    expect(pickerKeyAction("", keys({ return: true }), 3, 2)).toEqual({ kind: "submit", index: 2 })
    expect(pickerKeyAction("", keys({ escape: true }), 3, 0)).toEqual({ kind: "dismiss" })
  })

  test("digits 1-N submit the matching option instantly — the QCM fast path", () => {
    expect(pickerKeyAction("1", keys(), 3, 0)).toEqual({ kind: "submit", index: 0 })
    expect(pickerKeyAction("3", keys(), 3, 0)).toEqual({ kind: "submit", index: 2 })
  })

  test("out-of-range digits and regular typing fall through to the input", () => {
    expect(pickerKeyAction("4", keys(), 3, 0)).toEqual({ kind: "passthrough" }) // only 3 options
    expect(pickerKeyAction("0", keys(), 3, 0)).toEqual({ kind: "passthrough" })
    expect(pickerKeyAction("y", keys(), 3, 0)).toEqual({ kind: "passthrough" })
    expect(pickerKeyAction("/", keys(), 3, 0)).toEqual({ kind: "passthrough" })
  })
})
