import { describe, expect, it } from "vitest"
import { inputBorderColor, inputMode, inputModeHint, ROUTING_COLOR } from "../input-mode"

describe("inputMode", () => {
  it("detects slash, bang and plain text", () => {
    expect(inputMode("/help")).toBe("slash")
    expect(inputMode("!ls -la")).toBe("bang")
    expect(inputMode("hello @planner")).toBe("text")
    expect(inputMode("")).toBe("text")
  })

  it("only a LEADING prefix switches mode", () => {
    expect(inputMode("what does ! do?")).toBe("text")
    expect(inputMode("a/b path")).toBe("text")
  })
})

describe("inputBorderColor", () => {
  it("slash is yellow, bang is red — regardless of routing", () => {
    expect(inputBorderColor("slash", "manual", true)).toBe("yellow")
    expect(inputBorderColor("bang", "auto", true)).toBe("red")
  })

  it("plain text follows the routing mode", () => {
    expect(inputBorderColor("text", "auto", true)).toBe(ROUTING_COLOR.auto)
    expect(inputBorderColor("text", "semi", true)).toBe(ROUTING_COLOR.semi)
    expect(inputBorderColor("text", "manual", true)).toBe(ROUTING_COLOR.manual)
    expect(ROUTING_COLOR.auto).not.toBe(ROUTING_COLOR.semi)
  })

  it("a dead input is gray no matter the mode", () => {
    expect(inputBorderColor("slash", "auto", false)).toBe("gray")
    expect(inputBorderColor("bang", "auto", false)).toBe("gray")
    expect(inputBorderColor("text", "auto", false)).toBe("gray")
  })
})

describe("inputModeHint", () => {
  it("names shell and command mode, none for plain text", () => {
    expect(inputModeHint("bang")).toMatch(/shell/)
    expect(inputModeHint("slash")).toMatch(/command/)
    expect(inputModeHint("text")).toBeNull()
  })
})
