import { describe, expect, test } from "vitest"
import type { Receipt } from "@pipeline-moe/client-core"
import { headerRule, receiptLines } from "../transcript-format"

describe("headerRule", () => {
  test("embeds icon + name and pads with dashes to the full width", () => {
    const rule = headerRule("Tester", "🧪", 40)
    expect(rule.startsWith("── 🧪 Tester ")).toBe(true)
    expect(rule.length).toBe(40)
    expect(rule.endsWith("─")).toBe(true)
  })

  test("no icon — just the name", () => {
    const rule = headerRule("You", undefined, 30)
    expect(rule.startsWith("── You ")).toBe(true)
    expect(rule).not.toContain("undefined")
    expect(rule.length).toBe(30)
  })

  test("never pads negatively when the name exceeds the width", () => {
    const rule = headerRule("A very long agent name indeed", "🧭", 10)
    expect(rule).toBe("── 🧭 A very long agent name indeed ")
  })
})

describe("receiptLines", () => {
  const receipt = (over: Partial<Receipt> = {}): Receipt => ({
    participantId: "builder",
    created: [],
    modified: [],
    deleted: [],
    ...over,
  })

  test("empty receipt renders nothing — same contract as the web ReceiptView", () => {
    expect(receiptLines(receipt())).toEqual([])
  })

  test("header + one colored line per change, kinds in created/modified/deleted order", () => {
    const lines = receiptLines(
      receipt({ created: ["a.ts"], modified: ["b.md", "c.md"], deleted: ["d.txt"] }),
    )
    expect(lines[0]).toEqual({ text: "📦 work receipt — filesystem-verified", dim: true })
    expect(lines.slice(1)).toEqual([
      { text: "  + a.ts", color: "green" },
      { text: "  ~ b.md", color: "yellow" },
      { text: "  ~ c.md", color: "yellow" },
      { text: "  − d.txt", color: "red" },
    ])
  })
})
