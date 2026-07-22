import { describe, expect, test } from "vitest"
import { cursorRowCol, lineBounds, moveVertical, visibleWindow, wrapDraft } from "../multiline-input"

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

  describe("wrapDraft — soft-wrap so a long line grows the box, not an ellipsis", () => {
    test("a line within width stays one row", () => {
      expect(wrapDraft("hello", 5, 20)).toEqual({ rows: ["hello"], cursorRow: 0, cursorCol: 5 })
    })

    test("a long line wraps into visual rows and locates the cursor", () => {
      const r = wrapDraft("abcdefghij klmnopqrst uvwxyz", 15, 10)
      expect(r.rows).toEqual(["abcdefghij", " klmnopqrs", "t uvwxyz"])
      expect(r.rows.every((row) => row.length <= 10)).toBe(true)
      // flat 15 → 5 into the second row
      expect(r).toMatchObject({ cursorRow: 1, cursorCol: 5 })
      // concatenation is loss-free (cursor string-indices stay valid)
      expect(r.rows.join("")).toBe("abcdefghij klmnopqrst uvwxyz")
    })

    test("cursor at the end of a FULL row gets its own trailing row (no overflow)", () => {
      // Without this, the inverse cursor block would push the row one column
      // past the width → Ink re-wraps → the 2026-07-09 frame corruption.
      expect(wrapDraft("0123456789", 10, 10)).toEqual({ rows: ["0123456789", ""], cursorRow: 1, cursorCol: 0 })
    })

    test("real newlines and soft-wrap coexist; the boundary rolls to the next row's head", () => {
      const r = wrapDraft("short\nthis-one-is-really-long-indeed", 30, 12)
      expect(r.rows).toEqual(["short", "this-one-is-", "really-long-", "indeed"])
      expect(r).toMatchObject({ cursorRow: 3, cursorCol: 0 })
    })

    test("an empty draft is a single empty row", () => {
      expect(wrapDraft("", 0, 20)).toEqual({ rows: [""], cursorRow: 0, cursorCol: 0 })
    })

    test("wide glyphs count as display columns, not string length", () => {
      // Two double-width emoji already fill a width-4 row.
      const r = wrapDraft("🧭🔨ab", 0, 4)
      expect(r.rows).toEqual(["🧭🔨", "ab"])
    })
  })
})
