import { beforeAll, describe, expect, test, vi } from "vitest"
import chalk from "chalk"
import { visibleWidth } from "@earendil-works/pi-tui"
import type { Message, RosterItem } from "@pipeline-moe/client-core"
import { GraphOverlayComponent, flowRows, traceRows } from "../next/graph.js"

// The handoff graph. Every row is emoji + name + a bar, which is why the width
// assertions here are the interesting ones: this screen is where a disagreement
// between two rulers would knock a whole column out of line.

beforeAll(() => {
  chalk.level = 3
})

const plain = (ls: string[]): string[] => ls.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
const vis = (s: string): number => visibleWidth(s)
const text = (ls: string[]): string => plain(ls).join("\n")
const rows = () => 40

const ESC = "\x1b"
const UP = "\x1b[A"
const DOWN = "\x1b[B"

const roster: RosterItem[] = [
  { id: "planner", name: "Planner", color: "#8B5CF6", icon: "🧠", active: true, parallel: false, seat: "lead" },
  { id: "builder", name: "Builder", color: "#EF9F27", icon: "🔨", active: true, parallel: false },
  { id: "tester", name: "Tester", color: "#4A90D9", icon: "🧪", active: true, parallel: false },
] as RosterItem[]

/** A turn that walked you → planner → builder → tester → planner. */
const msg = (index: number, author: string, text: string): Message => ({
  index,
  author,
  authorName: author,
  text,
  ts: 1_700_000_000 + index,
})

const messages: Message[] = [
  msg(1, "user", "go"),
  msg(2, "planner", "dispatching"),
  msg(3, "builder", "built"),
  msg(4, "tester", "tested"),
  msg(5, "planner", "done"),
]

const make = (over: { messages?: Message[]; roster?: RosterItem[]; initialView?: "trace" | "flows" } = {}) => {
  const onClose = vi.fn()
  const c = new GraphOverlayComponent(
    {
      messages: () => over.messages ?? messages,
      roster: () => over.roster ?? roster,
      onClose,
      ...(over.initialView ? { initialView: over.initialView } : {}),
    },
    rows,
  )
  return { c, onClose }
}

describe("GraphOverlayComponent", () => {
  test("opens on the trace, numbered, with the first hop marked as the start", () => {
    const { c } = make()
    const out = text(c.render(80))
    expect(out).toContain("HANDOFF GRAPH")
    expect(out).toContain("1  ")
    expect(out).toContain("🧑 you")
    expect(out).toContain("start")
    // The hop INTO an agent from the user is a route; agent → agent is a handoff.
    expect(out).toContain("route")
    expect(out).toContain("handoff")
  })

  test("f switches to the ledger and t comes back", () => {
    const { c } = make()
    c.handleInput("f")
    const flows = text(c.render(80))
    expect(flows).toContain("→")
    expect(flows).toContain("×")
    c.handleInput("t")
    expect(text(c.render(80))).toContain("start")
  })

  test("switching view resets the scroll — the two reads have different lengths", () => {
    const { c } = make()
    c.handleInput(DOWN)
    c.handleInput(DOWN)
    c.handleInput("f")
    // Back on the trace, the window starts at the top again.
    c.handleInput("t")
    expect(text(c.render(80))).toContain("1  ")
  })

  test("esc and q both close", () => {
    const a = make()
    a.c.handleInput(ESC)
    expect(a.onClose).toHaveBeenCalled()
    const b = make()
    b.c.handleInput("q")
    expect(b.onClose).toHaveBeenCalled()
  })

  test("scroll cannot run past the end, and ↑ stops at the top", () => {
    // 3 rows of window (a 15-row terminal) over a 5-hop chain.
    const { c } = make()
    const short = new GraphOverlayComponent(
      { messages: () => messages, roster: () => roster, onClose: () => {} },
      () => 15,
    )
    for (let i = 0; i < 20; i++) short.handleInput(DOWN)
    const bottom = text(short.render(80))
    expect(bottom).toContain("5  ")
    expect(bottom).not.toContain("▼ more")
    for (let i = 0; i < 20; i++) short.handleInput(UP)
    const top = text(short.render(80))
    expect(top).toContain("1  ")
    expect(top).not.toContain("▲ more")
    expect(text(c.render(80))).toContain("HANDOFF GRAPH")
  })

  test("an empty room says so instead of drawing an empty box", () => {
    const { c } = make({ messages: [], roster: [] })
    expect(text(c.render(80))).toContain("No handoffs yet")
  })

  test("every framed line is exactly the width, at every width", () => {
    for (const view of ["trace", "flows"] as const) {
      for (const w of [40, 56, 80, 120, 200]) {
        const { c } = make({ initialView: view })
        for (const line of c.render(w)) expect(vis(line)).toBe(w)
      }
    }
  })

  test("the counts row reports handoffs and seats, singular when there is one", () => {
    const { c } = make({
      messages: [msg(1, "user", "go"), msg(2, "planner", "ok")],
    })
    expect(text(c.render(80))).toContain("1 handoff ·")
  })
})

describe("row builders", () => {
  test("traceRows aligns the name column with the TERMINAL's width, not string-width", () => {
    const chain = [
      { id: "user", name: "You", color: "#8b5cf6", icon: "🧑", turns: 0 },
      { id: "planner", name: "Planner", color: "#8B5CF6", icon: "🧠", turns: 1, type: "route" as const },
      { id: "x", name: "A", color: "#fff", icon: "▶", turns: 1, type: "handoff" as const },
    ]
    const out = plain(traceRows(chain, 0, 3, 78))
    // The type label starts at the same column on every row — that is what the
    // padding is for, and `▶` (ambiguous width) must not shift it.
    const cols = out.map((l) => l.search(/start|route|handoff/))
    expect(new Set(cols).size).toBe(1)
  })

  test("flowRows draws at least one bar for the rarest edge", () => {
    const graph = {
      nodes: [
        { id: "a", name: "A", color: "#fff", icon: "🅰", turns: 9 },
        { id: "b", name: "B", color: "#fff", icon: "🅱", turns: 1 },
      ],
      edges: [
        { source: "a", target: "b", count: 30, types: { handoff: 30 } },
        { source: "b", target: "a", count: 1, types: { route: 1 } },
      ],
      total: 31,
    }
    const out = plain(flowRows(graph, 0, 2, 78))
    expect(out[0]).toContain("█")
    expect(out[1]).toContain("█")
    // …and the bars are not the same length, or the ledger says nothing.
    expect((out[0]!.match(/█/g) ?? []).length).toBeGreaterThan((out[1]!.match(/█/g) ?? []).length)
  })

  test("a node missing from the roster still renders, rather than throwing", () => {
    const graph = {
      nodes: [],
      edges: [{ source: "ghost", target: "other", count: 2, types: { handoff: 2 } }],
      total: 2,
    }
    expect(plain(flowRows(graph, 0, 1, 78))[0]).toContain("ghost")
  })
})
