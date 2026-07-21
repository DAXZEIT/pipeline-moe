import { describe, expect, it } from "vitest"
import { seatMoves, modelsDiffer } from "../seats.js"
import type { RosterItem } from "../types.js"

const agent = (id: string, opts: Partial<RosterItem> = {}): RosterItem => ({
  id, name: id, color: "#a", icon: "🔹", tools: [], active: true, status: "idle", parallel: false, ...opts,
})

describe("seatMoves — shared join/pair/detach enumeration for fused seats", () => {
  it("singleton agent — nothing to join, pair with itself excluded, no detach", () => {
    const roster = [agent("a"), agent("b")]
    const moves = seatMoves(roster[0], roster)
    expect(moves.joins).toEqual([])
    expect(moves.pairs).toEqual([{ partner: roster[1], mismatch: false }])
    expect(moves.canDetach).toBe(false)
  })

  it("fused seats appear as join targets, own seat excluded", () => {
    const roster = [
      agent("a"),
      agent("b", { seat: "orch", model: "cloud/x" }),
      agent("c", { seat: "orch", model: "cloud/x" }),
      agent("d", { seat: "mem", model: "cloud/y" }),
    ]
    const moves = seatMoves(roster[0], roster)
    expect(moves.joins).toEqual([
      { seat: "orch", hats: [roster[1], roster[2]], mismatch: true },
      { seat: "mem", hats: [roster[3]], mismatch: true },
    ])
    expect(moves.pairs).toEqual([]) // all others fused or self
    expect(moves.canDetach).toBe(false)
  })

  it("fused agent sees OTHER fused seats but not its own", () => {
    const roster = [
      agent("a", { seat: "orch", model: "cloud/x" }),
      agent("b", { seat: "orch", model: "cloud/x" }),
      agent("c"),
      agent("d", { seat: "mem", model: "cloud/y" }),
    ]
    const moves = seatMoves(roster[0], roster)
    expect(moves.joins).toEqual([{ seat: "mem", hats: [roster[3]], mismatch: true }])
    expect(moves.pairs).toEqual([{ partner: roster[2], mismatch: true }])
    expect(moves.canDetach).toBe(true)
  })

  it("mismatch: different declared models", () => {
    const roster = [agent("a", { model: "local/g" }), agent("b", { seat: "s", model: "cloud/x" })]
    expect(seatMoves(roster[0], roster).joins[0]?.mismatch).toBe(true)
  })

  it("compatibility: same declared model", () => {
    const roster = [agent("a", { model: "local/g" }), agent("b", { seat: "s", model: "local/g" })]
    expect(seatMoves(roster[0], roster).joins[0]?.mismatch).toBe(false)
  })

  it("compatibility: both on default (undefined model)", () => {
    const roster = [agent("a"), agent("b", { seat: "s" })]
    expect(seatMoves(roster[0], roster).joins[0]?.mismatch).toBe(false)
  })

  it("mismatch: one declared, one default", () => {
    const roster = [agent("a", { model: "cloud/x" }), agent("b", { seat: "s" })]
    expect(seatMoves(roster[0], roster).joins[0]?.mismatch).toBe(true)
  })

  it("pair mismatch mirrors join mismatch (same model comparison)", () => {
    const roster = [
      agent("a", { model: "local/g" }),
      agent("b"),
      agent("c", { seat: "s", model: "local/g" }),
    ]
    const moves = seatMoves(roster[0], roster)
    expect(moves.pairs[0]?.mismatch).toBe(true) // b is default, a is declared → mismatch (server refuses)
    expect(moves.joins[0]?.mismatch).toBe(false)
  })
})

describe("modelsDiffer — declared model comparison for the one-seat-one-model invariant", () => {
  it("undefined on both = compatible (both on host default)", () => {
    expect(modelsDiffer({ id: "a" } as RosterItem, { id: "b" } as RosterItem)).toBe(false)
  })
  it("same declared model = compatible", () => {
    expect(modelsDiffer(agent("a", { model: "local/g" }), agent("b", { model: "local/g" }))).toBe(false)
  })
  it("different declared models = mismatch", () => {
    expect(modelsDiffer(agent("a", { model: "local/g" }), agent("b", { model: "cloud/x" }))).toBe(true)
  })
  it("one declared, one default = mismatch", () => {
    expect(modelsDiffer(agent("a", { model: "cloud/x" }), agent("b"))).toBe(true)
  })
  it("ignores seat field — comparison is purely on model", () => {
    expect(modelsDiffer(agent("a", { model: "local/g", seat: "x" }), agent("b", { model: "local/g" }))).toBe(false)
  })
})
