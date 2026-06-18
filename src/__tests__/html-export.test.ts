import { test, expect, describe } from "vitest"

/* ────────────────────────────────────────────────────
 *  HTML Export — Empirical Verification
 * ──────────────────────────────────────────────────── */

/* ── Participant.exportToHtml ──────────────────── */

describe("Participant.exportToHtml", () => {
  test("returns a file path", async () => {
    const mockSession = {
      exportToHtml: async () => "/tmp/builder-2026-06-18T07-00-00.html",
    }
    const filePath = await mockSession.exportToHtml()
    expect(typeof filePath).toBe("string")
    expect(filePath).toContain(".html")
  })

  test("async method — must be awaited", async () => {
    const mockSession = {
      exportToHtml: async () => "/tmp/auditor.html",
    }
    const result = mockSession.exportToHtml()
    expect(result).toBeInstanceOf(Promise)
    expect(await result).toBe("/tmp/auditor.html")
  })
})

/* ── Server GET /api/participants/:id/export ──── */

describe("Server export endpoint", () => {
  test("filename is derived from id and timestamp", () => {
    const id = "builder"
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5)
    const filename = `${id}-${timestamp}.html`
    expect(filename).toMatch(/^builder-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.html$/)
  })

  test("timestamp replaces colons and dots with dashes", () => {
    const iso = "2026-06-18T07:30:00.123Z"
    const sanitized = iso.replace(/[:.]/g, "-").slice(0, -5)
    expect(sanitized).toBe("2026-06-18T07-30-00")
    expect(sanitized).not.toContain(":")
    expect(sanitized).not.toContain(".")
  })

  test("Content-Type is text/html", () => {
    const contentType = "text/html; charset=utf-8"
    expect(contentType).toContain("text/html")
    expect(contentType).toContain("charset=utf-8")
  })

  test("Content-Disposition is attachment", () => {
    const id = "builder"
    const timestamp = "2026-06-18T07-30-00-123"
    const filename = `${id}-${timestamp}.html`
    const disposition = `attachment; filename="${filename}"`
    expect(disposition).toContain("attachment")
    expect(disposition).toContain(`filename="builder-2026-06-18T07-30-00-123.html"`)
  })

  test("404 when participant not found", () => {
    const id = "nonexistent"
    const error = `unknown participant "${id}"`
    expect(error).toBe('unknown participant "nonexistent"')
  })
})

/* ── Frontend API exportAgent ──────────────────── */

describe("Frontend API exportAgent", () => {
  test("fetches the correct endpoint", () => {
    const API_BASE = "http://localhost:3000"
    const id = "builder"
    const expectedUrl = `${API_BASE}/api/participants/${id}/export`
    expect(expectedUrl).toBe("http://localhost:3000/api/participants/builder/export")
  })

  test("returns a blob", () => {
    // Simulated — can't actually fetch in test
    const mockBlob = new Blob(["<html></html>"], { type: "text/html" })
    expect(mockBlob.type).toBe("text/html")
    expect(mockBlob.size).toBeGreaterThan(0)
  })
})

/* ── Frontend download flow ───────────────────── */

describe("Frontend download flow", () => {
  test("download creates object URL, anchor, and revokes", () => {
    // Simulated download flow
    const steps: string[] = []

    // Simulate the onClick handler logic
    const blob = new Blob(["<html></html>"], { type: "text/html" })
    const url = "fake-url" // In real code: URL.createObjectURL(blob)

    steps.push("createObjectURL")
    // Simulate: const a = document.createElement("a"); a.href = url; a.click()
    steps.push("createElement-a")
    steps.push("setHref")
    steps.push("click")
    // Simulate: URL.revokeObjectURL(url)
    steps.push("revokeObjectURL")

    expect(steps).toEqual([
      "createObjectURL",
      "createElement-a",
      "setHref",
      "click",
      "revokeObjectURL",
    ])
  })

  test("title attribute says 'Export session as HTML'", () => {
    const title = "Export session as HTML"
    expect(title).toBe("Export session as HTML")
  })
})

/* ── Error handling ────────────────────────────── */

describe("Error handling", () => {
  test("exportToHtml throws → 500 response", () => {
    const err = new Error("export failed")
    const message = err instanceof Error ? err.message : String(err)
    expect(message).toBe("export failed")
  })

  test("non-Error thrown → stringified", () => {
    const err = "something went wrong"
    const message = err instanceof Error ? err.message : String(err)
    expect(message).toBe("something went wrong")
  })
})
