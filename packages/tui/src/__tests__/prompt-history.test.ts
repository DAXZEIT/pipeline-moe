import { describe, expect, test } from "vitest"
import { newPromptHistory, pushPrompt, recallNext, recallPrev } from "../prompt-history"

describe("prompt history", () => {
  test("empty history recalls nothing", () => {
    const h = newPromptHistory()
    expect(recallPrev(h, "draft")).toBeNull()
    expect(recallNext(h)).toBeNull()
  })

  test("↑ parks the draft and walks back; ↓ walks forward and restores it", () => {
    const h = newPromptHistory()
    pushPrompt(h, "first")
    pushPrompt(h, "second")
    expect(recallPrev(h, "my draft")).toBe("second")
    expect(recallPrev(h, "second")).toBe("first")
    expect(recallNext(h)).toBe("second")
    expect(recallNext(h)).toBe("my draft") // past the newest → draft restored
    expect(recallNext(h)).toBeNull() // not navigating anymore
  })

  test("↑ at the oldest entry stays put", () => {
    const h = newPromptHistory()
    pushPrompt(h, "only")
    expect(recallPrev(h, "d")).toBe("only")
    expect(recallPrev(h, "only")).toBeNull()
    expect(h.index).toBe(0)
  })

  test("push resets navigation and collapses consecutive duplicates", () => {
    const h = newPromptHistory()
    pushPrompt(h, "a")
    pushPrompt(h, "a")
    pushPrompt(h, "b")
    expect(h.entries).toEqual(["a", "b"])
    recallPrev(h, "")
    pushPrompt(h, "c")
    expect(h.index).toBe(-1)
    expect(h.draft).toBe("")
  })

  test("empty submissions are not recorded", () => {
    const h = newPromptHistory()
    pushPrompt(h, "")
    expect(h.entries).toEqual([])
  })

  test("history stays capped at 100", () => {
    const h = newPromptHistory()
    for (let i = 0; i < 130; i++) pushPrompt(h, `msg ${i}`)
    expect(h.entries.length).toBe(100)
    expect(h.entries[0]).toBe("msg 30")
    expect(h.entries[99]).toBe("msg 129")
  })
})
