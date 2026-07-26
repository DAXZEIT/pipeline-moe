import { describe, expect, test } from "vitest"
import { cleanPtyCapture, exitCodeOf } from "../pty-capture.js"

// A `!` command's capture can become shared room context, so what the agents
// read must be plain text — and must not depend on which client ran it. This was
// untested while it lived private inside App.tsx.

describe("cleanPtyCapture", () => {
  test("colours and cursor moves come out", () => {
    expect(cleanPtyCapture("\x1b[31mred\x1b[0m")).toBe("red")
    expect(cleanPtyCapture("a\x1b[2Kb")).toBe("ab")
  })

  test("a progress bar collapses to its final state, not to a wall of rewrites", () => {
    expect(cleanPtyCapture("10%\r50%\r100%\n")).toBe("100%\n")
  })

  test("`script` chatter is dropped", () => {
    const raw = "Script started on 2026-07-26 10:00:00\nhello\nScript done on 2026-07-26 10:00:01\n"
    expect(cleanPtyCapture(raw)).toBe("hello\n")
  })

  test("OSC titles and hyperlinks come out", () => {
    expect(cleanPtyCapture("\x1b]0;my title\x07done")).toBe("done")
  })

  test("stray control bytes come out but newlines and tabs survive", () => {
    expect(cleanPtyCapture("a\x00b\x07c\n\td")).toBe("abc\n\td")
  })

  test("plain output passes through unchanged", () => {
    expect(cleanPtyCapture("total 4\ndrwxr-xr-x\n")).toBe("total 4\ndrwxr-xr-x\n")
  })
})

describe("exitCodeOf", () => {
  test("a clean run is 0 and a failure keeps its code", () => {
    expect(exitCodeOf({ status: 0, signal: null }, "")).toBe(0)
    expect(exitCodeOf({ status: 2, signal: null }, "")).toBe(2)
  })

  test("a user interrupt is 130, not a failure", () => {
    expect(exitCodeOf({ status: null, signal: "SIGINT" }, "")).toBe(130)
  })

  test("^C in the capture outranks a non-zero exit", () => {
    // A command that traps SIGINT and exits 1 itself (ping to an unreachable
    // host) is indistinguishable from a real error by exit code alone — the
    // pty's echo is the only evidence the user stopped it.
    expect(exitCodeOf({ status: 1, signal: null }, "PING …\n^C\n")).toBe(130)
  })

  test("a kill is 143, and any other signal at least reads as failure", () => {
    expect(exitCodeOf({ status: null, signal: "SIGTERM" }, "")).toBe(143)
    expect(exitCodeOf({ status: null, signal: "SIGSEGV" }, "")).toBe(1)
  })

  test("no status and no signal is not a failure", () => {
    expect(exitCodeOf({ status: null, signal: null }, "")).toBe(0)
  })
})
