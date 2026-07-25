import { describe, expect, test } from "vitest"
import type { ToolActivity } from "../types.js"
import { fmtDuration, toolDuration, SLOW_TOOL_MS } from "../format.js"

const call = (durationMs?: number): ToolActivity => ({
  toolCallId: String(Math.random()),
  toolName: "read",
  status: "ok",
  ts: 0,
  ...(durationMs === undefined ? {} : { durationMs }),
})

describe("fmtDuration", () => {
  test("sub-10s keeps a decimal, past that it does not", () => {
    expect(fmtDuration(800)).toBe("0.8s")
    expect(fmtDuration(8240)).toBe("8.2s")
    expect(fmtDuration(42_100)).toBe("42s")
  })

  test("a minute switches unit", () => {
    expect(fmtDuration(74_000)).toBe("1m14s")
    expect(fmtDuration(3_600_000)).toBe("60m00s")
  })
})

describe("toolDuration", () => {
  test("a fast call draws nothing", () => {
    // Every durationMs recorded so far is 1-15 ms (local fs tools). Printing
    // "0.0s" on all of them is what this threshold exists to prevent.
    expect(toolDuration([call(2)])).toBeUndefined()
    expect(toolDuration([call(SLOW_TOOL_MS - 1)])).toBeUndefined()
  })

  test("a slow call draws its duration", () => {
    expect(toolDuration([call(SLOW_TOOL_MS)])).toBe("1.0s")
    expect(toolDuration([call(42_100)])).toBe("42s")
  })

  test("a burst is summed, so one slow call in it still surfaces", () => {
    expect(toolDuration([call(3), call(3), call(3)])).toBeUndefined()
    expect(toolDuration([call(3), call(4000), call(3)])).toBe("4.0s")
  })

  test("unknown duration is not zero — pre-durationMs history draws nothing", () => {
    expect(toolDuration([call(), call()])).toBeUndefined()
    // A partially-known burst reports what it knows rather than nothing: the
    // total is a lower bound, and a lower bound past the threshold is still a
    // true statement that this burst was slow.
    expect(toolDuration([call(), call(2000)])).toBe("2.0s")
  })

  test("an empty run has nothing to report", () => {
    expect(toolDuration([])).toBeUndefined()
  })
})
