import { describe, expect, it } from "vitest"
import { previewRouting } from "../mentions.js"

const roster = [
  { id: "planner", active: true },
  { id: "builder", active: true },
  { id: "tester", active: true },
  { id: "scribe", active: false },
]

describe("previewRouting — mirror of Room.resolveTargets for user messages", () => {
  it("no mention routes to defaultAgent", () => {
    expect(previewRouting("fix the drain", roster, "planner")).toEqual({
      kind: "default", targetIds: ["planner"], dropped: [],
    })
  })

  it("no mention, no defaultAgent → first active", () => {
    expect(previewRouting("hello", roster, null).targetIds).toEqual(["planner"])
  })

  it("@all fans out to every active agent", () => {
    expect(previewRouting("@all status?", roster, null)).toEqual({
      kind: "all", targetIds: ["planner", "builder", "tester"], dropped: [],
    })
  })

  it("explicit mentions, insertion order, case-insensitive", () => {
    expect(previewRouting("@Tester then @builder", roster, null)).toEqual({
      kind: "mentions", targetIds: ["tester", "builder"], dropped: [],
    })
  })

  it("unknown and inactive mentions are dropped, visibly", () => {
    expect(previewRouting("@scribe and @ghost do it", roster, null)).toEqual({
      kind: "mentions", targetIds: [], dropped: ["scribe", "ghost"],
    })
  })

  it("THE incident: a pasted report quoting handoff traces routes both agents", () => {
    const pasted =
      'here is the smoke report: ✗ @builder → @tester refused — "pong3" is not ' +
      "a substantive completion. Great result!"
    expect(previewRouting(pasted, roster, "planner")).toEqual({
      kind: "mentions", targetIds: ["builder", "tester"], dropped: [],
    })
  })

  it("empty roster → none", () => {
    expect(previewRouting("anything", [], null).kind).toBe("none")
  })
})
