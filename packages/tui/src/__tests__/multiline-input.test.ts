import { describe, expect, test } from "vitest"
import { cursorRowCol, lineBounds, moveVertical, visibleWindow } from "../multiline-input"

describe("multiline input", () => {
  const text = "first\nsecond line\nthird"

  test("cursorRowCol maps flat indices to line/column", () => {
    expect(cursorRowCol(text, 0)).toEqual({ row: 0, col: 0 })
    expect(cursorRowCol(text, 5)).toEqual({ row: 0, col: 5 }) // end of "first"
    expect(cursorRowCol(text, 6)).toEqual({ row: 1, col: 0 }) // start of "second line"
    expect(cursorRowCol(text, text.length)).toEqual({ row: 2, col: 5 })
  })

  test("lineBounds brackets the cursor's line without its newline", () => {
    expect(lineBounds(text, 3)).toEqual({ start: 0, end: 5 })
    expect(lineBounds(text, 6)).toEqual({ start: 6, end: 17 })
    expect(lineBounds(text, text.length)).toEqual({ start: 18, end: 23 })
  })

  test("moveVertical keeps the column and clamps to shorter lines", () => {
    // "second line" col 8 → "first" clamps to length 5
    const onSecond = 6 + 8
    expect(moveVertical(text, onSecond, -1)).toBe(5)
    // "second line" col 8 → "third" clamps to length 5 → 18 + 5
    expect(moveVertical(text, onSecond, 1)).toBe(23)
    // col 2 survives both directions
    expect(moveVertical(text, 6 + 2, -1)).toBe(2)
    expect(moveVertical(text, 6 + 2, 1)).toBe(18 + 2)
  })

  test("moveVertical returns null at the boundaries (history takes over)", () => {
    expect(moveVertical(text, 3, -1)).toBeNull() // first line
    expect(moveVertical(text, text.length, 1)).toBeNull() // last line
    expect(moveVertical("single", 3, -1)).toBeNull()
    expect(moveVertical("single", 3, 1)).toBeNull()
  })

  test("visibleWindow shows everything that fits", () => {
    expect(visibleWindow(3, 1, 6)).toEqual({ start: 0, end: 3 })
  })

  test("visibleWindow centers on the cursor and clamps at the ends", () => {
    expect(visibleWindow(10, 0, 6)).toEqual({ start: 0, end: 6 })
    expect(visibleWindow(10, 5, 6)).toEqual({ start: 2, end: 8 })
    expect(visibleWindow(10, 9, 6)).toEqual({ start: 4, end: 10 })
  })
})
