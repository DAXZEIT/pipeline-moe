import { expect, test } from "vitest"
import { assertInside } from "../path-guard.js"

// ── Valid paths should not throw ───────────────────────────────────────

test("valid relative path passes", () => {
  expect(() => assertInside("/workspace", "/workspace/file.txt")).not.toThrow()
})

test("valid nested path passes", () => {
  expect(() => assertInside("/workspace", "/workspace/src/file.ts")).not.toThrow()
})

test("root itself passes", () => {
  expect(() => assertInside("/workspace", "/workspace")).not.toThrow()
})

// ── Path traversal attempts must throw ─────────────────────────────────

test("traversal via ../ in filename throws", () => {
  expect(() => assertInside("/workspace", "/workspace/../../../etc/passwd")).toThrow("Permission denied")
})

test("traversal via ../ in middle of path throws", () => {
  expect(() => assertInside("/workspace", "/workspace/foo/../../etc/passwd")).toThrow("Permission denied")
})

test("traversal to parent directory throws", () => {
  expect(() => assertInside("/workspace", "/workspace/..")).toThrow("Permission denied")
})

test("absolute path outside root throws", () => {
  expect(() => assertInside("/workspace", "/etc/passwd")).toThrow("Permission denied")
})

test("traversal via backslash (Windows-style) throws", () => {
  // On Linux this won't naturally occur, but the guard is there.
  expect(() => assertInside("/workspace", "/workspace/..\\..\\etc\\passwd")).toThrow("Permission denied")
})

test("traversal with double-dot prefix in segment throws", () => {
  expect(() => assertInside("/workspace", "/workspace/../../tmp")).toThrow("Permission denied")
})
