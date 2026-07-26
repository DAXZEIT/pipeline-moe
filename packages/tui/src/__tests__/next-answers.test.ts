import { beforeAll, describe, expect, test } from "vitest"
import chalk from "chalk"
import { visibleWidth } from "@earendil-works/pi-tui"
import { AnswerPickerComponent } from "../next/answers.js"

// The QCM picker. The DECISIONS are `answer-picker.ts`'s and already tested there;
// what these cover is the pi-tui wiring: which bytes it claims, when it is on
// screen at all, and that it occupies zero rows when it is not (the Ink client had
// to book `n + 4` rows even while hidden).

beforeAll(() => {
  chalk.level = 3
})

const plain = (ls: string[]): string[] => ls.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
const vis = (s: string): number => visibleWidth(s)
const text = (ls: string[]): string => plain(ls).join("\n")

const ESC = "\x1b"
const ENTER = "\r"
const UP = "\x1b[A"
const DOWN = "\x1b[B"
const CTRL_P = "\x10"

const OPTIONS = ["ship it", "hold for review", "abandon"]

function make(over: { options?: string[] | null; draft?: string; asker?: string | null } = {}) {
  const answered: string[] = []
  let options = over.options === undefined ? OPTIONS : over.options
  let draft = over.draft ?? ""
  const c = new AnswerPickerComponent({
    options: () => options,
    askerId: () => (over.asker === undefined ? "planner" : over.asker),
    draft: () => draft,
    onAnswer: (t) => answered.push(t),
    requestRender: () => {},
  })
  return {
    c,
    answered,
    setOptions: (o: string[] | null) => (options = o),
    setDraft: (d: string) => (draft = d),
  }
}

describe("AnswerPickerComponent", () => {
  test("renders nothing — not a blank box — when there is no question", () => {
    const { c } = make({ options: null })
    expect(c.render(80)).toEqual([])
    expect(c.visible()).toBe(false)
  })

  test("renders nothing while a draft is being typed: free text wins", () => {
    const { c } = make({ draft: "my own answer" })
    expect(c.render(80)).toEqual([])
  })

  test("names the asker and numbers the choices", () => {
    const { c } = make()
    const out = text(c.render(80))
    expect(out).toContain("@planner asks")
    expect(out).toContain("1 ship it")
    expect(out).toContain("3 abandon")
    expect(out).toContain("1-3 answer")
  })

  test("a question with no asker still renders its header", () => {
    const { c } = make({ asker: null })
    expect(text(c.render(80))).toContain("pick an answer")
  })

  test("↑↓ move the highlight and wrap around", () => {
    const { c } = make()
    c.handleKey(DOWN)
    expect(text(c.render(80))).toContain("▶ 2 hold for review")
    c.handleKey(UP)
    c.handleKey(UP)
    expect(text(c.render(80))).toContain("▶ 3 abandon")
  })

  test("⏎ answers with the highlighted option", () => {
    const { c, answered } = make()
    c.handleKey(DOWN)
    expect(c.handleKey(ENTER)).toBe(true)
    expect(answered).toEqual(["hold for review"])
  })

  test("a digit answers instantly — the QCM fast path", () => {
    const { c, answered } = make()
    expect(c.handleKey("3")).toBe(true)
    expect(answered).toEqual(["abandon"])
  })

  test("a digit past the end is NOT claimed — it is the start of a free-text answer", () => {
    const { c, answered } = make()
    expect(c.handleKey("7")).toBe(false)
    expect(answered).toEqual([])
  })

  test("esc hides the picker for this question only", () => {
    const { c, setOptions } = make()
    expect(c.handleKey(ESC)).toBe(true)
    expect(c.render(80)).toEqual([])
    // A NEW question brings it back, highlight reset.
    setOptions(["yes", "no"])
    expect(c.visible()).toBe(true)
    expect(text(c.render(80))).toContain("▶ 1 yes")
  })

  test("a new question resets the highlight — answer 2 must not become the default", () => {
    const { c, setOptions } = make()
    c.handleKey(DOWN)
    c.handleKey(DOWN)
    setOptions(["a", "b", "c"])
    expect(text(c.render(80))).toContain("▶ 1 a")
  })

  test("letters and chords fall through so typing stays free", () => {
    const { c } = make()
    expect(c.handleKey("s")).toBe(false)
    expect(c.handleKey(CTRL_P)).toBe(false)
  })

  test("claims nothing at all while hidden — the editor keeps every key", () => {
    const { c } = make({ draft: "typing" })
    for (const k of [UP, DOWN, ENTER, ESC, "1"]) expect(c.handleKey(k)).toBe(false)
  })

  test("every framed line is exactly the width, including a choice longer than it", () => {
    const { c } = make({ options: ["a".repeat(300), "short"] })
    for (const w of [40, 56, 80, 120]) {
      for (const line of c.render(w)) expect(vis(line)).toBe(w)
    }
  })
})
