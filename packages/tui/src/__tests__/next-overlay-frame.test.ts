import { beforeAll, describe, expect, test } from "vitest"
import chalk from "chalk"
import stringWidth from "string-width"
import { visibleWidth } from "@earendil-works/pi-tui"
import { fitLine, frame, moreMarker, twoColumn, windowStart } from "../next/overlay-frame.js"

// The overlay box. pi-tui THROWS on a rendered line wider than the viewport, an
// overlay is composited at a column offset INSIDE that viewport, and its content
// is the least predictable text in the app — model refs, preset names off disk,
// server error strings. So width is the invariant this file exists for.

beforeAll(() => {
  chalk.level = 3
})

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")
// The terminal's ruler, not string-width's — see next/overlay-frame.ts. The two
// disagree on `▶`, and padding asserted with the overcounting measure is how a
// focused row shipped a column short of its own border.
const vis = (s: string): number => visibleWidth(s)
const widths = [200, 120, 80, 60, 40, 20, 10, 4]

describe("frame", () => {
  const long = "a".repeat(400)

  test("every line is EXACTLY the width — a box with a ragged edge is not a box", () => {
    for (const w of widths) {
      for (const line of frame({ title: "Presets", body: ["one", "two"], hint: "esc cancel", color: "magenta" }, w)) {
        expect(vis(line)).toBe(w)
      }
    }
  })

  test("over-long content is truncated, never wrapped onto a line the box did not budget", () => {
    for (const w of widths) {
      const ls = frame({ title: long, body: [long, long], hint: long, color: "cyan" }, w)
      expect(ls).toHaveLength(6) // top, title, 2 body, hint, bottom
      for (const line of ls) expect(vis(line)).toBe(w)
    }
  })

  test("height is exactly the body plus four rows of box", () => {
    const ls = frame({ title: "t", body: ["a", "b", "c"], hint: "h", color: "cyan" }, 40)
    expect(ls).toHaveLength(3 + 4)
    expect(plain(ls[0]!)).toMatch(/^╭─+╮$/)
    expect(plain(ls[ls.length - 1]!)).toMatch(/^╰─+╯$/)
  })

  test("an empty body still produces a valid box", () => {
    const ls = frame({ title: "t", body: [], hint: "h", color: "cyan" }, 40)
    expect(ls).toHaveLength(4)
    for (const line of ls) expect(vis(line)).toBe(40)
  })

  test("a width below the border's own cost does not throw or go negative", () => {
    for (const w of [0, 1, 2, 3]) {
      expect(() => frame({ title: "t", body: ["x"], hint: "h", color: "cyan" }, w)).not.toThrow()
      for (const line of frame({ title: "t", body: ["x"], hint: "h", color: "cyan" }, w)) {
        expect(vis(line)).toBe(4)
      }
    }
  })

  test("the title's right-hand side is dim and follows the title", () => {
    const ls = frame({ title: "Presets", titleRight: "3/12", body: [], hint: "h", color: "magenta" }, 60)
    const title = plain(ls[1]!)
    expect(title.indexOf("Presets")).toBeLessThan(title.indexOf("3/12"))
  })

  test("ANSI in the body does not count toward the width", () => {
    // Otherwise a coloured agent name would be truncated as though the escape
    // codes were visible characters.
    const painted = chalk.hex("#4A90D9")("🔍 Scout") + "  " + chalk.cyan("GRM 2.6")
    const ls = frame({ title: "t", body: [painted], hint: "h", color: "cyan" }, 40)
    expect(plain(ls[2]!)).toContain("GRM 2.6")
    expect(vis(ls[2]!)).toBe(40)
  })
})

describe("twoColumn", () => {
  test("the right column reaches the right edge", () => {
    const line = twoColumn("Scout", "GRM 2.6", 40)
    expect(vis(line)).toBe(40)
    expect(plain(line).endsWith("GRM 2.6")).toBe(true)
  })

  test("no right column means no padding — nothing to align against", () => {
    expect(plain(twoColumn("Scout", "", 40))).toBe("Scout")
  })

  test("when the label fills the row the hint is dropped, not squeezed to nothing", () => {
    // A 2-character hint fragment is noise; the label is the information.
    const line = twoColumn("x".repeat(39), "GRM 2.6", 40)
    expect(vis(line)).toBeLessThanOrEqual(40)
    expect(plain(line)).not.toContain("G")
  })

  test("never exceeds the width, at any width", () => {
    for (const w of widths) {
      expect(vis(twoColumn("a".repeat(100), "b".repeat(100), w))).toBeLessThanOrEqual(w)
    }
  })
})

describe("moreMarker", () => {
  test("absent still occupies a row, so the box does not resize on an arrow key", () => {
    // A box that changes height as the cursor moves rewrites every line below it
    // on every keypress.
    expect(moreMarker(false, "▲")).not.toBe("")
    expect(plain(moreMarker(true, "▼"))).toContain("▼")
  })
})

describe("windowStart", () => {
  test("a list that fits starts at the top", () => {
    expect(windowStart(0, 3, 10)).toBe(0)
    expect(windowStart(2, 3, 10)).toBe(0)
  })

  test("the cursor is centred in the middle of a long list", () => {
    expect(windowStart(50, 100, 10)).toBe(45)
  })

  test("clamped at both ends — no blank rows above the first or below the last", () => {
    expect(windowStart(0, 100, 10)).toBe(0)
    expect(windowStart(99, 100, 10)).toBe(90)
  })
})

describe("fitLine", () => {
  test("fits the width pi-tui and the terminal both count in", () => {
    // `▶` (U+25B6) is East Asian Ambiguous — string-width says 2 columns, pi-tui
    // and the terminal say 1. Fitting to the stricter measure looks safe and is
    // not: it throws away a column the box actually had, which is how a task
    // owner rendered as "@s…" in a room 80 columns wide.
    const arrows = "▶".repeat(30)
    for (const w of widths) {
      expect(vis(fitLine(arrows, w))).toBeLessThanOrEqual(w)
      // 30 arrows are 30 columns, so anything from 30 up must survive whole.
      if (w >= 30) expect(plain(fitLine(arrows, w))).toBe(arrows)
    }
    // And the overcounting measure is the one that would have cropped it.
    expect(stringWidth(arrows)).toBe(60)
  })
})
