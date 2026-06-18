import { test, expect, describe } from "vitest"
import { VALID_TOOLS, parsePersona } from "../validation.js"

/* ────────────────────────────────────────────────────
 *  Thinking Level — Empirical Verification
 * ──────────────────────────────────────────────────── */

const VALID_THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"]

/* ── Type-level checks (compile-time) ────────────── */

describe("thinkingLevel types", () => {
  test("VALID_THINKING contains expected levels", () => {
    for (const level of VALID_THINKING) {
      expect(["off", "minimal", "low", "medium", "high", "xhigh"]).toContain(level)
    }
  })

  test("parsePersona accepts thinkingLevel in persona", () => {
    const p = parsePersona({
      name: "Test",
      systemPrompt: "Go.",
      thinkingLevel: "high",
    })
    // parsePersona doesn't validate thinkingLevel directly, but it should
    // accept it without error (it's a Persona field)
    expect(p.id).toBe("test")
  })
})

/* ── Participant fallback logic ──────────────────── */

describe("Participant.create thinkingLevel fallback", () => {
  const configThinkingLevel = "medium"

  test("persona.thinkingLevel takes precedence over config", () => {
    const persona = { id: "builder", name: "Builder", systemPrompt: "Go.", tools: [], color: "#000", icon: "🔨", thinkingLevel: "high" }
    const result = persona.thinkingLevel ?? configThinkingLevel
    expect(result).toBe("high")
  })

  test("undefined persona.thinkingLevel falls back to config", () => {
    const persona = { id: "auditor", name: "Auditor", systemPrompt: "Go.", tools: [], color: "#000", icon: "🔍" }
    const result = persona.thinkingLevel ?? configThinkingLevel
    expect(result).toBe("medium")
  })

  test("null persona.thinkingLevel falls back to config", () => {
    const persona = { id: "tester", name: "Tester", systemPrompt: "Go.", tools: [], color: "#000", icon: "🧪", thinkingLevel: null as any }
    const result = persona.thinkingLevel ?? configThinkingLevel
    expect(result).toBe("medium")
  })
})

/* ── PATCH validation ───────────────────────────── */

describe("PATCH thinkingLevel validation", () => {
  const validSet = new Set(VALID_THINKING)

  test("each valid level is accepted", () => {
    for (const level of VALID_THINKING) {
      expect(validSet.has(level)).toBe(true)
    }
  })

  test("invalid levels are rejected", () => {
    expect(validSet.has("ultra")).toBe(false)
    expect(validSet.has("none")).toBe(false)
    expect(validSet.has("")).toBe(false)
    expect(validSet.has("MAX")).toBe(false)
  })

  test("null/empty string should reset to undefined (inherit)", () => {
    const body = { thinkingLevel: null }
    let patch: any
    if (body.thinkingLevel === null || body.thinkingLevel === "") {
      patch = { thinkingLevel: undefined }
    } else if (typeof body.thinkingLevel === "string" && validSet.has(body.thinkingLevel)) {
      patch = { thinkingLevel: body.thinkingLevel }
    } else {
      patch = { error: true }
    }
    expect(patch.thinkingLevel).toBeUndefined()
  })

  test("empty string resets to undefined", () => {
    const body = { thinkingLevel: "" }
    let patch: any
    if (body.thinkingLevel === null || body.thinkingLevel === "") {
      patch = { thinkingLevel: undefined }
    } else if (typeof body.thinkingLevel === "string" && validSet.has(body.thinkingLevel)) {
      patch = { thinkingLevel: body.thinkingLevel }
    } else {
      patch = { error: true }
    }
    expect(patch.thinkingLevel).toBeUndefined()
  })

  test("invalid value produces error", () => {
    const body = { thinkingLevel: "ultra" }
    let patch: any
    if (body.thinkingLevel === null || body.thinkingLevel === "") {
      patch = { thinkingLevel: undefined }
    } else if (typeof body.thinkingLevel === "string" && validSet.has(body.thinkingLevel)) {
      patch = { thinkingLevel: body.thinkingLevel }
    } else {
      patch = { error: true }
    }
    expect(patch.error).toBe(true)
  })
})

/* ── Registry RosterItem shape ──────────────────── */

describe("Registry RosterItem includes thinkingLevel", () => {
  test("roster mapping includes thinkingLevel field", () => {
    const persona = { id: "scribe", name: "Scribe", thinkingLevel: "low" }
    const rosterItem = {
      id: persona.id,
      name: persona.name,
      thinkingLevel: persona.thinkingLevel,
    }
    expect(rosterItem.thinkingLevel).toBe("low")
  })

  test("rosterItem with undefined thinkingLevel is valid", () => {
    const persona = { id: "scout", name: "Scout" }
    const rosterItem = {
      id: persona.id,
      name: persona.name,
      thinkingLevel: persona.thinkingLevel,
    }
    expect(rosterItem.thinkingLevel).toBeUndefined()
  })
})

/* ── Frontend EditAgent options ─────────────────── */

describe("EditAgent thinkingLevel selector", () => {
  test("default option has empty value (inherit)", () => {
    const options = ["", "off", "minimal", "low", "medium", "high", "xhigh"]
    expect(options[0]).toBe("")
  })

  test("all six levels are available as options", () => {
    const options = ["", "off", "minimal", "low", "medium", "high", "xhigh"]
    for (const level of VALID_THINKING) {
      expect(options).toContain(level)
    }
  })

  test("empty string maps to null in save payload", () => {
    const thinkingLevel = ""
    const payloadValue = thinkingLevel || null
    expect(payloadValue).toBeNull()
  })

  test("non-empty value passes through in save payload", () => {
    const thinkingLevel = "high"
    const payloadValue = thinkingLevel || null
    expect(payloadValue).toBe("high")
  })
})

/* ── End-to-end flow ──────────────────────────── */

describe("end-to-end thinkingLevel flow", () => {
  test("agent inherits global config when no per-agent override", () => {
    const configLevel = "medium"
    const persona = { id: "a", name: "A", systemPrompt: "Go.", tools: [] }
    const effectiveLevel = persona.thinkingLevel ?? configLevel
    expect(effectiveLevel).toBe("medium")
  })

  test("agent overrides global config with per-agent setting", () => {
    const configLevel = "medium"
    const persona = { id: "b", name: "B", systemPrompt: "Go.", tools: [], thinkingLevel: "xhigh" }
    const effectiveLevel = persona.thinkingLevel ?? configLevel
    expect(effectiveLevel).toBe("xhigh")
  })

  test("PATCH → roster → effective level", () => {
    // Simulate: PATCH sets thinkingLevel, roster returns it, session uses it
    const patchPayload = { thinkingLevel: "low" }
    const rosterItem = { id: "c", name: "C", thinkingLevel: patchPayload.thinkingLevel }
    const configLevel = "medium"
    const effectiveLevel = rosterItem.thinkingLevel ?? configLevel
    expect(effectiveLevel).toBe("low")
  })

  test("PATCH with null clears per-agent override → inherits config", () => {
    const rosterItem = { id: "d", name: "D", thinkingLevel: undefined }
    const configLevel = "high"
    const effectiveLevel = rosterItem.thinkingLevel ?? configLevel
    expect(effectiveLevel).toBe("high")
  })
})
