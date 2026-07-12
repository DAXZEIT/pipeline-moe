import { describe, expect, it } from "vitest"
import { describeRosterBlock, modelLabel, toolSummary } from "../roster-awareness.js"

describe("modelLabel", () => {
  it("tags cloud refs verbatim", () => {
    expect(modelLabel("anthropic/claude-opus-4-8")).toBe("anthropic/claude-opus-4-8 [cloud]")
  })
  it("tags local refs and strips the gguf extension", () => {
    expect(modelLabel("local/Qwopus3.6-27B-v2-MTP-Q4_K_M.gguf")).toBe("Qwopus3.6-27B-v2-MTP-Q4_K_M [local GPU]")
  })
  it("null → room default", () => {
    expect(modelLabel(null)).toBe("room default model")
  })
})

describe("toolSummary — over the seed roster shapes", () => {
  it("planner: read-only + orchestration", () => {
    expect(toolSummary(["read", "grep", "find", "ls", "spawn_room", "check_room", "stop_room", "destroy_room", "answer_room"]))
      .toBe("read-only + orchestration")
  })
  it("builder: read/write/edit/bash", () => {
    expect(toolSummary(["read", "bash", "edit", "write", "grep", "find", "ls"])).toBe("read/write/edit/bash")
  })
  it("auditor: read-only", () => {
    expect(toolSummary(["read", "grep", "find", "ls"])).toBe("read-only")
  })
  it("scout: read-only + web (no mutating hands, eyes on the web)", () => {
    expect(toolSummary(["read", "grep", "find", "ls", "web_search", "web_read", "youtube_transcript", "arxiv_search", "youcom_search"]))
      .toBe("read-only + web")
  })
  it("tester: read/bash", () => {
    expect(toolSummary(["read", "bash", "grep", "find", "ls"])).toBe("read/bash")
  })
  it("fetcher: read/write/bash/web", () => {
    expect(toolSummary(["web_read", "bash", "read", "write", "grep", "find", "ls"])).toBe("read/write/bash/web")
  })
  it("read-only + web (a web-only scout variant)", () => {
    expect(toolSummary(["read", "web_search"])).toBe("read-only + web")
  })
})

describe("describeRosterBlock", () => {
  const members = [
    { id: "planner", name: "Planner", modelRef: "anthropic/claude-fable-5", tools: ["read", "grep", "find", "ls", "spawn_room"] },
    { id: "builder", name: "Builder", modelRef: "anthropic/claude-opus-4-8", tools: ["read", "bash", "edit", "write"] },
    { id: "tester", name: "Tester", modelRef: "local/Qwopus3.6-27B-v2.gguf", tools: ["read", "bash"], vision: true },
  ]

  it("one line per member, self marked, vision flagged, guidance footer present", () => {
    const block = describeRosterBlock(members, "planner")
    expect(block).toContain("- @planner (Planner) — anthropic/claude-fable-5 [cloud] — read-only + orchestration ← you")
    expect(block).toContain("- @builder (Builder) — anthropic/claude-opus-4-8 [cloud] — read/write/edit/bash")
    expect(block).toContain("- @tester (Tester) — Qwopus3.6-27B-v2 [local GPU] — read/bash · vision")
    expect(block).toContain("Write for the member you address")
  })

  it("the self marker follows the receiver", () => {
    const block = describeRosterBlock(members, "tester")
    expect(block).toContain("read/bash · vision ← you")
    expect(block).not.toContain("orchestration ← you")
  })

  it("fused seats: seat annotation, every hat of a fused seat is 'you'", () => {
    const fused = [
      members[0],
      { ...members[1], modelRef: "local/Qwopus3.6-27B-v2.gguf", seatId: "maker", seatMates: ["tester"] },
      { ...members[2], seatId: "maker", seatMates: ["builder"] },
    ]
    const block = describeRosterBlock(fused, ["builder", "tester"])
    expect(block).toContain("read/write/edit/bash — maker seat (shared context with @tester) ← you")
    expect(block).toContain("· vision — maker seat (shared context with @builder) ← you")
    expect(block).not.toContain("orchestration ← you")
    expect(block).toContain("skip the re-brief")
  })
})
