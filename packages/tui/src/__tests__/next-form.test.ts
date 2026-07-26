import { beforeAll, describe, expect, test } from "vitest"
import chalk from "chalk"
import { visibleWidth } from "@earendil-works/pi-tui"
import { FormComponent, formBudget, windowRows, wrapChips, type FormRow } from "../next/form.js"

// The form engine. One keyboard loop for four forms, so this is where the
// interaction contract is pinned down: which keys reach which row kind, that the
// cursor cannot land on a note, that the submit row survives a short screen, and
// that every line still fits the width no matter what the fields contain.

beforeAll(() => {
  chalk.level = 3
})

const plain = (ls: string[]): string[] => ls.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
// WIDTH IS MEASURED THE WAY THE TERMINAL DOES IT, not with `string-width`.
// `▶` is East Asian Ambiguous: string-width says 2 columns, pi-tui and every
// terminal we run in say 1. Asserting with string-width means measuring the
// padding with the same wrong ruler that produced it, which is exactly how a
// focused form row shipped one column short of its own border in Phase 3.
const vis = (s: string): number => visibleWidth(s)
const text = (ls: string[]): string => plain(ls).join("\n")

const ESC = "\x1b"
const ENTER = "\r"
const UP = "\x1b[A"
const DOWN = "\x1b[B"
const LEFT = "\x1b[D"
const RIGHT = "\x1b[C"
const TAB = "\t"
const BACKSPACE = "\x7f"
const SPACE = " "

/** A form with one of every row kind, its state observable from outside. */
function fixture(rows = 40) {
  const state = { name: "", pick: 0, tools: ["read"] as string[], submits: 0, cancels: 0 }
  const PICKS = ["alpha", "beta", "gamma"]
  const form = new FormComponent(
    {
      title: () => "Fixture",
      color: "green",
      rows: (): FormRow[] => [
        {
          kind: "text",
          label: "Name",
          placeholder: "type it",
          get: () => state.name,
          update: (f) => (state.name = f(state.name)),
        },
        { kind: "note", lines: () => ["a note the cursor must skip"] },
        {
          kind: "cycle",
          label: "Pick",
          view: () => PICKS[state.pick]!,
          left: () => (state.pick = (state.pick - 1 + PICKS.length) % PICKS.length),
          right: () => (state.pick = (state.pick + 1) % PICKS.length),
        },
        {
          kind: "chips",
          label: "Tools",
          items: ["read", "bash", "edit"],
          on: (t) => state.tools.includes(t),
          toggle: (t) => (state.tools = state.tools.includes(t) ? state.tools.filter((x) => x !== t) : [...state.tools, t]),
        },
        { kind: "action", label: () => "Create" },
      ],
      onSubmit: () => (state.submits += 1),
      onCancel: () => (state.cancels += 1),
    },
    () => rows,
  )
  return { form, state }
}

describe("text rows", () => {
  test("typing appends, backspace removes a code point", () => {
    const { form, state } = fixture()
    for (const c of "Rev") form.handleInput(c)
    expect(state.name).toBe("Rev")
    form.handleInput("🐺")
    form.handleInput(BACKSPACE)
    // Naive slice(0, -1) would leave a lone surrogate here.
    expect(state.name).toBe("Rev")
  })

  test("a pasted chunk with newlines flattens rather than shredding the box", () => {
    const { form, state } = fixture()
    form.handleInput("one\ntwo\r\nthree")
    expect(state.name).toBe("one two three")
    expect(state.name).not.toContain("\n")
  })

  test("the placeholder shows only while empty, and the caret only while focused", () => {
    const { form, state } = fixture()
    expect(text(form.render(60))).toContain("type it")
    form.handleInput("x")
    expect(text(form.render(60))).not.toContain("type it")
    expect(form.render(60).join("")).toContain("▌")
    // Move off the field: the caret goes with the focus.
    form.handleInput(DOWN)
    const off = form.render(60).join("")
    expect(off.match(/▌/g) ?? []).toHaveLength(0)
    expect(state.name).toBe("x")
  })

  test("a custom filter narrows what a field will accept", () => {
    let v = ""
    const form = new FormComponent({
      title: () => "t",
      color: "green",
      rows: (): FormRow[] => [
        { kind: "text", label: "slug", filter: (c) => c.replace(/[^a-z-]/g, ""), get: () => v, update: (f) => (v = f(v)) },
      ],
      onSubmit: () => {},
      onCancel: () => {},
    })
    form.handleInput("My Preset 42!")
    expect(v).toBe("yreset")
  })

  test("onEnter commits the field before the cursor advances", () => {
    const order: string[] = []
    let v = ""
    const form = new FormComponent({
      title: () => "t",
      color: "green",
      rows: (): FormRow[] => [
        { kind: "text", label: "a", onEnter: () => order.push("commit"), get: () => v, update: (f) => (v = f(v)) },
        { kind: "action", label: () => "Go" },
      ],
      onSubmit: () => order.push("submit"),
      onCancel: () => {},
    })
    form.handleInput(ENTER)
    form.handleInput(ENTER)
    expect(order).toEqual(["commit", "submit"])
  })

  test("a long value collapses when unfocused and opens back up when focused", () => {
    const long = "x".repeat(200)
    let v = long
    const form = new FormComponent({
      title: () => "t",
      color: "green",
      rows: (): FormRow[] => [
        { kind: "text", label: "prompt", long: true, get: () => v, update: (f) => (v = f(v)) },
        { kind: "text", label: "other", get: () => "", update: () => {} },
      ],
      onSubmit: () => {},
      onCancel: () => {},
    })
    // Focused: the field is the full value, fitted to the width by the frame.
    expect(text(form.render(300))).toContain("x".repeat(200))
    form.handleInput(DOWN)
    expect(text(form.render(300))).toContain("…")
    expect(text(form.render(300))).not.toContain("x".repeat(100))
  })
})

describe("cursor movement", () => {
  test("↑↓ and tab skip note rows entirely", () => {
    const { form, state } = fixture()
    // Row 0 is the text field, row 1 is a note, row 2 the cycle.
    form.handleInput(DOWN)
    form.handleInput(RIGHT)
    expect(state.pick).toBe(1) // reached the cycle, not the note
    form.handleInput(UP)
    form.handleInput("z")
    expect(state.name).toBe("z") // back on the text field
    form.handleInput(TAB)
    form.handleInput(LEFT)
    expect(state.pick).toBe(0)
  })

  test("movement clamps at both ends rather than wrapping", () => {
    const { form, state } = fixture()
    for (let i = 0; i < 10; i++) form.handleInput(UP)
    form.handleInput("a")
    expect(state.name).toBe("a")
    for (let i = 0; i < 10; i++) form.handleInput(DOWN)
    form.handleInput(ENTER)
    expect(state.submits).toBe(1)
  })

  test("⏎ advances until the action row, where it submits", () => {
    const { form, state } = fixture()
    form.handleInput(ENTER) // text → cycle (the note is skipped)
    form.handleInput(ENTER) // cycle → chips
    expect(state.submits).toBe(0)
    form.handleInput(ENTER) // chips → action
    expect(state.submits).toBe(0)
    form.handleInput(ENTER)
    expect(state.submits).toBe(1)
  })

  test("esc cancels from anywhere", () => {
    const { form, state } = fixture()
    form.handleInput(DOWN)
    form.handleInput(ESC)
    expect(state.cancels).toBe(1)
    expect(state.submits).toBe(0)
  })
})

describe("cycle and chip rows", () => {
  test("←→ cycles and wraps", () => {
    const { form, state } = fixture()
    form.handleInput(DOWN)
    form.handleInput(LEFT)
    expect(state.pick).toBe(2)
    form.handleInput(RIGHT)
    expect(state.pick).toBe(0)
  })

  test("⏎ on a cycle with `enter` opens the catalogue instead of advancing", () => {
    let opened = 0
    let submits = 0
    const form = new FormComponent({
      title: () => "t",
      color: "green",
      rows: (): FormRow[] => [
        { kind: "cycle", label: "model", view: () => "host default", left: () => {}, right: () => {}, enter: () => (opened += 1) },
        { kind: "action", label: () => "Go" },
      ],
      onSubmit: () => (submits += 1),
      onCancel: () => {},
    })
    form.handleInput(ENTER)
    form.handleInput(ENTER)
    expect(opened).toBe(2)
    expect(submits).toBe(0) // the cursor never left the model row
  })

  test("←→ moves the chip cursor and space flips the one under it", () => {
    const { form, state } = fixture()
    form.handleInput(DOWN)
    form.handleInput(DOWN) // on the chips row, cursor at "read"
    form.handleInput(SPACE)
    expect(state.tools).toEqual([]) // read was on, now off
    form.handleInput(RIGHT)
    form.handleInput(SPACE)
    expect(state.tools).toEqual(["bash"])
  })

  test("the chip cursor is shared across rows but clamped per row", () => {
    let on = new Set<string>()
    const form = new FormComponent({
      title: () => "t",
      color: "green",
      rows: (): FormRow[] => [
        { kind: "chips", label: "wide", items: ["a", "b", "c", "d"], on: (i) => on.has(i), toggle: (i) => on.add(i) },
        { kind: "chips", label: "narrow", items: ["x", "y"], on: (i) => on.has(i), toggle: (i) => on.add(i) },
      ],
      onSubmit: () => {},
      onCancel: () => {},
    })
    for (let i = 0; i < 3; i++) form.handleInput(RIGHT) // cursor 3, on "d"
    form.handleInput(SPACE)
    expect([...on]).toEqual(["d"])
    form.handleInput(DOWN) // the narrow row has only 2 items
    form.handleInput(SPACE)
    expect([...on]).toEqual(["d", "y"]) // clamped to the last, not out of bounds
  })

  test("the legend names the keys the focused row actually uses", () => {
    const { form } = fixture()
    expect(text(form.render(90))).toContain("⏎ next")
    form.handleInput(DOWN)
    expect(text(form.render(90))).toContain("←→ cycle")
    form.handleInput(DOWN)
    expect(text(form.render(90))).toContain("space toggle")
    form.handleInput(DOWN)
    expect(text(form.render(90))).toContain("⏎ create")
  })
})

describe("errors", () => {
  test("setError shows the message and the next keystroke on a field clears it", () => {
    const { form } = fixture()
    form.setError("Name is required.")
    expect(text(form.render(60))).toContain("Name is required.")
    form.handleInput("a")
    expect(text(form.render(60))).not.toContain("Name is required.")
  })

  test("focusLabel sends the cursor to the field being complained about", () => {
    const { form, state } = fixture()
    form.handleInput(DOWN)
    form.handleInput(DOWN)
    form.focusLabel("Name")
    form.handleInput("q")
    expect(state.name).toBe("q")
  })
})

describe("wrapChips", () => {
  test("breaks at the width and never returns nothing", () => {
    const chips = ["■read  ", "□bash  ", "□edit  ", "□write  "]
    expect(wrapChips(chips, 100, "")).toHaveLength(1)
    expect(wrapChips(chips, 20, "")).toHaveLength(2)
    // A chip wider than the terminal still produces a line.
    expect(wrapChips(["□a-very-long-tool-name  "], 5, "")).toHaveLength(1)
  })

  test("every line fits the width", () => {
    const chips = Array.from({ length: 30 }, (_, i) => `□tool_number_${i}  `)
    for (const w of [120, 80, 40, 20, 10]) {
      for (const line of wrapChips(chips, w, "  ")) expect(vis(line)).toBeLessThanOrEqual(w)
    }
  })
})

describe("windowRows", () => {
  const g = (n: number) => Array.from({ length: n }, () => ({ lines: 1, focusable: true }))

  test("shows everything when it fits", () => {
    expect(windowRows(g(5), 0, 10)).toEqual({ start: 0, end: 5 })
  })

  test("keeps the focused row inside the window", () => {
    for (let focus = 0; focus < 20; focus++) {
      const { start, end } = windowRows(g(20), focus, 5)
      expect(focus).toBeGreaterThanOrEqual(start)
      expect(focus).toBeLessThan(end)
    }
  })

  test("prefers growing downward, so the action row survives", () => {
    // Focus in the middle of 20 rows with room for 5: the window should reach
    // further below than above.
    const { start, end } = windowRows(g(20), 10, 5)
    expect(end - 1 - 10).toBeGreaterThanOrEqual(10 - start)
  })

  test("respects multi-line groups", () => {
    const groups = [
      { lines: 1, focusable: true },
      { lines: 4, focusable: true },
      { lines: 1, focusable: true },
      { lines: 1, focusable: true },
    ]
    const { start, end } = windowRows(groups, 0, 3)
    const used = groups.slice(start, end).reduce((n, x) => n + x.lines, 0)
    expect(used).toBeLessThanOrEqual(3)
  })
})

describe("formBudget", () => {
  test("never exceeds what an 80%-height overlay can print", () => {
    for (const rows of [10, 14, 24, 30, 40, 60, 100]) {
      for (const err of [false, true]) {
        const budget = formBudget(rows, err)
        // What the host actually gives us: 80% of the screen, less the frame's
        // four lines. The body is the budget plus two markers plus the error.
        const printable = Math.floor(rows * 0.8) - 4
        const printed = budget + 2 + (err ? 1 : 0)
        if (budget > 3) expect(printed).toBeLessThanOrEqual(printable)
      }
    }
  })

  test("never goes below three rows, however small the terminal", () => {
    expect(formBudget(1, true)).toBe(3)
    expect(formBudget(8, false)).toBeGreaterThanOrEqual(3)
  })
})

describe("layout", () => {
  test("every rendered line is exactly the requested width", () => {
    const { form } = fixture()
    form.setError("A failure message from the server that is quite long indeed, honestly.")
    for (const w of [200, 120, 80, 60, 40, 20, 10, 4]) {
      for (const line of form.render(w)) expect(vis(line)).toBe(Math.max(4, w))
    }
  })

  test("a short screen windows the rows and keeps the action reachable", () => {
    const { form, state } = fixture(14)
    // Walk to the action row; the window must follow.
    form.handleInput(DOWN)
    form.handleInput(DOWN)
    form.handleInput(DOWN)
    const out = text(form.render(70))
    expect(out).toContain("[ Create ]")
    expect(out).toContain("esc cancel")
    form.handleInput(ENTER)
    expect(state.submits).toBe(1)
  })

  test("the markers appear only when rows are actually hidden", () => {
    expect(text(fixture(40).form.render(70))).not.toContain("more")
    const tall = new FormComponent(
      {
        title: () => "t",
        color: "green",
        rows: (): FormRow[] => [
          ...Array.from({ length: 30 }, (_, i): FormRow => ({ kind: "text", label: `f${i}`, get: () => "", update: () => {} })),
          { kind: "action", label: () => "Go" },
        ],
        onSubmit: () => {},
        onCancel: () => {},
      },
      () => 24,
    )
    // Focus starts at the top, so there is nothing above and plenty below.
    const out = text(tall.render(70))
    expect(out).toContain("▼ more")
    expect(out).not.toContain("▲ more")
  })
})
