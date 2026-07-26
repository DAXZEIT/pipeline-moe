import { describe, expect, test } from "vitest"
import { ROUTING_ORDER, classifySubmit, nextRoutingMode } from "../next/submit.js"

describe("classifySubmit", () => {
  test("the three sigils", () => {
    expect(classifySubmit("/help")).toEqual({ kind: "command", input: "/help" })
    expect(classifySubmit("!ls -la")).toEqual({ kind: "shell", command: "ls -la" })
    expect(classifySubmit("hello room")).toEqual({ kind: "send", text: "hello room" })
  })

  test("an empty draft is a GESTURE, not a message", () => {
    // The "+ room" tab reads a bare ⏎; it must be distinguishable from a draft
    // that had content and did nothing.
    expect(classifySubmit("")).toEqual({ kind: "empty" })
    expect(classifySubmit("   \n  ")).toEqual({ kind: "empty" })
  })

  test("a lone ! clears without acting", () => {
    // Typed, so not a gesture; empty, so not a command. Anything else would
    // either swallow the gesture or run an empty shell line.
    expect(classifySubmit("!")).toEqual({ kind: "noop" })
    expect(classifySubmit("!   ")).toEqual({ kind: "noop" })
  })

  test("an image can go out with no text at all", () => {
    expect(classifySubmit("", 1)).toEqual({ kind: "send", text: "" })
    expect(classifySubmit("", 0)).toEqual({ kind: "empty" })
  })

  test("surrounding whitespace never changes what a submission MEANS", () => {
    expect(classifySubmit("  /help  ")).toEqual({ kind: "command", input: "/help" })
    expect(classifySubmit("  !ls  ")).toEqual({ kind: "shell", command: "ls" })
  })

  test("a sigil mid-text is text", () => {
    expect(classifySubmit("run ! for shell")).toEqual({ kind: "send", text: "run ! for shell" })
    expect(classifySubmit("see docs/a /b")).toEqual({ kind: "send", text: "see docs/a /b" })
  })

  test("a multiline draft sends whole, newlines included", () => {
    expect(classifySubmit("first\nsecond")).toEqual({ kind: "send", text: "first\nsecond" })
  })
})

describe("nextRoutingMode", () => {
  test("⇧⇥ cycles the whole order and comes back", () => {
    let m = ROUTING_ORDER[0]!
    const seen = [m]
    for (let i = 0; i < ROUTING_ORDER.length; i++) {
      m = nextRoutingMode(m)
      seen.push(m)
    }
    expect(seen.slice(0, ROUTING_ORDER.length)).toEqual(ROUTING_ORDER)
    expect(seen[seen.length - 1]).toBe(ROUTING_ORDER[0])
  })

  test("the order is the escalation order", () => {
    expect(ROUTING_ORDER).toEqual(["auto", "semi", "manual", "supervised"])
  })
})
