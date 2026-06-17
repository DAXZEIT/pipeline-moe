import { expect, test } from "vitest"
import { parsePersona, VALID_TOOLS } from "../validation.js"

// ── VALID_TOOLS ─────────────────────────────────────────────────────────

test("VALID_TOOLS contains expected tools", () => {
  const expected = ["read", "bash", "edit", "write", "grep", "find", "ls"]
  for (const t of expected) {
    expect(VALID_TOOLS.has(t)).toBe(true)
  }
})

test("VALID_TOOLS rejects unknown tools", () => {
  expect(VALID_TOOLS.has("delete")).toBe(false)
  expect(VALID_TOOLS.has("curl")).toBe(false)
  expect(VALID_TOOLS.has("")).toBe(false)
})

// ── parsePersona — happy path ──────────────────────────────────────────

test("valid persona is parsed correctly", () => {
  const p = parsePersona({
    name: "Test Agent",
    systemPrompt: "You are a test agent.",
    tools: ["read", "bash"],
    color: "#FF0000",
    icon: "🧪",
  })
  expect(p.id).toBe("test-agent")
  expect(p.name).toBe("Test Agent")
  expect(p.tools).toEqual(["read", "bash"])
  expect(p.color).toBe("#FF0000")
  expect(p.icon).toBe("🧪")
  expect(p.systemPrompt).toBe("You are a test agent.")
})

test("default tools when tools not provided", () => {
  const p = parsePersona({
    name: "Minimal",
    systemPrompt: "Go.",
  })
  expect(p.tools).toEqual(["read", "grep", "find", "ls"])
  expect(p.color).toBe("#888888")
  expect(p.icon).toBe("🤖")
})

test("id is derived from name when not provided", () => {
  const p = parsePersona({
    name: "My Agent",
    systemPrompt: "Go.",
  })
  expect(p.id).toBe("my-agent")
})

test("id uses provided id field", () => {
  const p = parsePersona({
    name: "Agent",
    id: "custom-id",
    systemPrompt: "Go.",
  })
  expect(p.id).toBe("custom-id")
})

// ── parsePersona — tool filtering ──────────────────────────────────────

test("invalid tools are filtered out", () => {
  const p = parsePersona({
    name: "Agent",
    systemPrompt: "Go.",
    tools: ["read", "delete", "bash", "curl"],
  })
  expect(p.tools).toEqual(["read", "bash"])
})

// ── parsePersona — validation errors ───────────────────────────────────

test("throws when name is missing", () => {
  expect(() => parsePersona({ systemPrompt: "Go." })).toThrow("`name` is required")
})

test("throws when name is empty string", () => {
  expect(() => parsePersona({ name: "", systemPrompt: "Go." })).toThrow("`name` is required")
})

test("throws when name is only whitespace", () => {
  expect(() => parsePersona({ name: "   ", systemPrompt: "Go." })).toThrow("`name` is required")
})

test("throws when systemPrompt is missing", () => {
  expect(() => parsePersona({ name: "Agent" })).toThrow("`systemPrompt` is required")
})

test("throws when systemPrompt is empty", () => {
  expect(() => parsePersona({ name: "Agent", systemPrompt: "  " })).toThrow("`systemPrompt` is required")
})

test("throws when id cannot be derived (special chars only)", () => {
  expect(() => parsePersona({ name: "!@#", systemPrompt: "Go." })).toThrow("could not derive a valid id from name")
})
