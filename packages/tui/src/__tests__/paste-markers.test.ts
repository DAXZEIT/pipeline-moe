import { describe, expect, test } from "vitest"
import { expandPastes, isPastey, markerSpanAt, newPasteStore, stashPaste } from "../paste-markers"

describe("paste markers", () => {
  test("small inserts are not paste-ish", () => {
    expect(isPastey("hello")).toBe(false)
    expect(isPastey("two\nlines")).toBe(false)
    expect(isPastey("a\nb\nc\nd")).toBe(false) // 4 lines = boundary, still inline
  })

  test("a 5-line chunk is paste-ish", () => {
    expect(isPastey("a\nb\nc\nd\ne")).toBe(true)
  })

  test("stash returns a marker carrying id and line count", () => {
    const store = newPasteStore()
    const marker = stashPaste(store, "l1\nl2\nl3\nl4\nl5")
    expect(marker).toBe("[#1 paste +5 lines]")
    expect(store.map.get(1)).toBe("l1\nl2\nl3\nl4\nl5")
  })

  test("expand replaces intact markers and leaves unknown ids literal", () => {
    const store = newPasteStore()
    const m1 = stashPaste(store, "AAA\nBBB\nCCC\nDDD\nEEE")
    const text = `look: ${m1} and [#9 paste +3 lines]`
    expect(expandPastes(store, text)).toBe("look: AAA\nBBB\nCCC\nDDD\nEEE and [#9 paste +3 lines]")
  })

  test("a mangled marker stays literal", () => {
    const store = newPasteStore()
    stashPaste(store, "x\ny\nz\nw\nv")
    // user deleted a char inside the marker
    expect(expandPastes(store, "[#1 paste +5 line]")).toBe("[#1 paste +5 line]")
  })

  test("two pastes expand independently", () => {
    const store = newPasteStore()
    const m1 = stashPaste(store, "1\n2\n3\n4\n5")
    const m2 = stashPaste(store, "a\nb\nc\nd\ne\nf")
    expect(expandPastes(store, `${m2} ${m1}`)).toBe("a\nb\nc\nd\ne\nf 1\n2\n3\n4\n5")
  })

  test("markerSpanAt finds the marker ending at a position (atomic backspace)", () => {
    const store = newPasteStore()
    const m = stashPaste(store, "q\nw\ne\nr\nt")
    const text = `say ${m}!`
    const end = 4 + m.length
    expect(markerSpanAt(text, end, "ending")).toEqual({ start: 4, end, id: 1 })
    expect(markerSpanAt(text, end - 1, "ending")).toBeNull()
  })

  test("markerSpanAt finds the marker starting at a position (atomic delete)", () => {
    const store = newPasteStore()
    const m = stashPaste(store, "q\nw\ne\nr\nt")
    const text = `say ${m}!`
    expect(markerSpanAt(text, 4, "starting")).toEqual({ start: 4, end: 4 + m.length, id: 1 })
    expect(markerSpanAt(text, 5, "starting")).toBeNull()
  })
})
