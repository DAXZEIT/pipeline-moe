import { describe, expect, test } from "vitest"
import { shouldAbortOnEscape } from "../escape-behavior"

// F7 (knownissues.md): TUI had no discoverable, one-keystroke way to stop a
// running turn ("workaround = switch to manual mode before the turn ends").
// Esc on an empty line was previously a no-op — this repurposes it to abort,
// but ONLY in that exact state, so it never surprises someone mid-edit.

describe("shouldAbortOnEscape", () => {
  test("true when a turn is running, an abort handler exists, and the line is genuinely empty", () => {
    expect(shouldAbortOnEscape({ turnActive: true, hasOnAbort: true, value: "", pendingImageCount: 0 })).toBe(true)
  })

  test("true when pendingImageCount is undefined (treated as zero)", () => {
    expect(shouldAbortOnEscape({ turnActive: true, hasOnAbort: true, value: "", pendingImageCount: undefined })).toBe(true)
  })

  test("false when no turn is running — Esc keeps its normal clear behavior", () => {
    expect(shouldAbortOnEscape({ turnActive: false, hasOnAbort: true, value: "", pendingImageCount: 0 })).toBe(false)
  })

  test("false when there is typed text — Esc must clear it, not abort", () => {
    expect(shouldAbortOnEscape({ turnActive: true, hasOnAbort: true, value: "/abo", pendingImageCount: 0 })).toBe(false)
  })

  test("false when there is a pending image — Esc must clear it, not abort", () => {
    expect(shouldAbortOnEscape({ turnActive: true, hasOnAbort: true, value: "", pendingImageCount: 1 })).toBe(false)
  })

  test("false when no abort handler was supplied", () => {
    expect(shouldAbortOnEscape({ turnActive: true, hasOnAbort: false, value: "", pendingImageCount: 0 })).toBe(false)
  })
})
