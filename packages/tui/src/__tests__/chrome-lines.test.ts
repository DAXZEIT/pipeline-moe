import { beforeAll, describe, expect, test } from "vitest"
import chalk from "chalk"
import stringWidth from "string-width"
import type { Notice, RoomSummary, RoomTask, RosterItem } from "@pipeline-moe/client-core"
import { chromeLines, type ChromeInput } from "../chrome-lines.js"

// The chrome moved BELOW the conversation, which is the migration's one visible
// product change and its one load-bearing layout constraint: chrome above an
// append-only transcript rewrites lines that have scrolled into the terminal's
// scrollback, and pi-tui answers that by clearing it.
//
// Two things this file is really guarding:
//
//  1. WIDTH. pi-tui throws — with a crash log — if a rendered line exceeds the
//     viewport width, where Ink silently truncated. So every chrome line must
//     fit at every width, including the awkward narrow ones.
//  2. HEIGHT STABILITY. A chrome line's index is near the end of the buffer, so
//     changing height is free — but only if it changes for a REASON. A row that
//     appears and disappears on its own would churn the bottom of the screen.

beforeAll(() => {
  // Force truecolor: with no TTY chalk emits nothing, and then the width
  // assertions below would be measuring un-styled strings — i.e. not the
  // strings the terminal actually receives.
  chalk.level = 3
})

const roster: RosterItem[] = [
  { id: "scout", name: "Scout", color: "#4A90D9", icon: "🔍", active: true } as RosterItem,
  { id: "builder", name: "Builder", color: "#EF9F27", icon: "🔨", active: true } as RosterItem,
]

const rooms: RoomSummary[] = [
  { roomId: "default", name: "main-room", participantCount: 2, goalStatus: "idle", goalText: null },
  { roomId: "sub", name: "sub-room", participantCount: 1, goalStatus: "running", goalText: "ship it" },
]

const base: ChromeInput = {
  roomId: "default",
  rooms,
  plusSelected: false,
  roster,
  runningAgentId: null,
  defaultModel: "GRM 2.6",
  tasks: [],
  notices: [],
  connection: "connected",
  turnActive: false,
  runningSince: null,
  paused: false,
  pausedAskerId: null,
  routingMode: "auto",
  messageCount: 12,
  now: 1_000_000,
}

const at = (over: Partial<ChromeInput> = {}, width = 120): string[] => chromeLines({ ...base, ...over }, width)
const plain = (ls: string[]): string[] => ls.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))

describe("width", () => {
  // The one invariant that is a CRASH rather than a cosmetic bug.
  const widths = [200, 120, 80, 60, 40, 20, 10]

  test("every line fits, at every width, with the chrome fully loaded", () => {
    const loaded: Partial<ChromeInput> = {
      turnActive: true,
      runningAgentId: "scout",
      runningSince: 1_000_000 - 7_300,
      tasks: [
        { id: 1, subject: "extract the transcript renderer so both clients share it", status: "in_progress", createdBy: "user", ts: 0 },
        { id: 2, subject: "move the chrome below the conversation", status: "in_progress", createdBy: "user", ts: 0 },
        { id: 3, subject: "done already", status: "completed", createdBy: "user", ts: 0 },
      ],
      notices: [
        { id: 1, msg: "preset NEWMAIN loaded — 5 agents, 1 seat", level: "info" },
        { id: 2, msg: "room 'sub' failed to resume: manifest missing", level: "error" },
      ],
      drift: { preset: "NEWMAIN", deviates: true },
      roomUsage: { tokens: 148_000, hotPercent: 91 },
      draftTargets: { t: ["builder", "auditor"], d: ["nobody-here"] },
    }
    for (const w of widths) {
      for (const line of at(loaded, w)) {
        expect(stringWidth(line.replace(/\x1b\[[0-9;]*m/g, ""))).toBeLessThanOrEqual(w)
      }
    }
  })

  test("the divider is exactly the width — it is the boundary, it must not be short", () => {
    for (const w of widths) expect(plain(at({}, w))[0]).toHaveLength(w)
  })

  test("width 0 does not throw or produce a negative-length rule", () => {
    expect(() => at({}, 0)).not.toThrow()
    expect(plain(at({}, 0))[0]).toBe("")
  })
})

describe("height changes only for a reason", () => {
  const height = (over: Partial<ChromeInput> = {}): number => at(over).length

  test("an empty task board and no notices cost zero rows", () => {
    const bare = height()
    expect(height({ tasks: [], notices: [] })).toBe(bare)
  })

  test("tasks add exactly one row, however many there are", () => {
    const bare = height()
    const one: RoomTask[] = [{ id: 1, subject: "a", status: "pending", createdBy: "user", ts: 0 }]
    const many: RoomTask[] = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      subject: `task ${i}`,
      status: "in_progress" as const,
      createdBy: "user",
      ts: 0,
    }))
    expect(height({ tasks: one })).toBe(bare + 1)
    expect(height({ tasks: many })).toBe(bare + 1)
  })

  test("notices are capped at three, so a burst cannot push the editor off-screen", () => {
    const bare = height()
    const burst: Notice[] = Array.from({ length: 20 }, (_, i) => ({ id: i, msg: `n${i}`, level: "info" as const }))
    expect(height({ notices: burst })).toBe(bare + 3)
    // …and it keeps the most RECENT, which is the useful end of a burst.
    expect(plain(at({ notices: burst })).some((l) => l.includes("n19"))).toBe(true)
    expect(plain(at({ notices: burst })).some((l) => l.includes("n0"))).toBe(false)
  })

  test("an empty roster drops the strip rather than rendering an empty one", () => {
    expect(at({ roster: [] }).length).toBeLessThan(at().length)
  })

  test("height does not depend on the clock", () => {
    const a = at({ turnActive: true, runningAgentId: "scout", runningSince: 0, now: 5_000 })
    const b = at({ turnActive: true, runningAgentId: "scout", runningSince: 0, now: 3_600_000 })
    expect(a.length).toBe(b.length)
  })
})

describe("order", () => {
  test("the divider opens and the status bar closes", () => {
    const ls = plain(at({ tasks: [{ id: 1, subject: "x", status: "pending", createdBy: "user", ts: 0 }] }))
    expect(ls[0]).toMatch(/^─+$/)
    expect(ls[ls.length - 1]).toContain("connected")
    // The tab strip sits directly under the rule, then the roster.
    expect(ls[1]).toContain("main-room")
    expect(ls[2]).toContain("Scout")
  })
})

describe("status bar", () => {
  const status = (over: Partial<ChromeInput>): string => {
    const ls = plain(at(over))
    return ls[ls.length - 1]!
  }

  test("a paused room does not read as idle", () => {
    // Saying "idle" here made a legitimate 409 on another action read as a
    // corrupted state — the room holds a frozen queue and waits on the user.
    const s = status({ paused: true, pausedAskerId: "scout" })
    expect(s).toContain("paused")
    expect(s).toContain("@scout")
    expect(s).not.toContain("idle")
  })

  test("a running turn names the agent and its elapsed time", () => {
    const s = status({ turnActive: true, runningAgentId: "scout", runningSince: 1_000_000 - 7_300 })
    expect(s).toContain("running")
    expect(s).toContain("Scout")
    expect(s).toContain("7.3s")
  })

  test("pause wins over a running turn — the queue is frozen either way", () => {
    const s = status({ paused: true, turnActive: true, runningAgentId: "scout" })
    expect(s).toContain("paused")
  })

  test("an idle room says so, and offers no stop key", () => {
    const s = status({})
    expect(s).toContain("idle")
    expect(s).not.toContain("Esc to stop")
  })

  test("drift marks a deviating preset, and says nothing when there is no preset", () => {
    expect(status({ drift: { preset: "NEWMAIN", deviates: true } })).toContain("preset:NEWMAIN")
    expect(status({ drift: { preset: "NEWMAIN", deviates: true } })).toContain("*")
    expect(status({ drift: { preset: "NEWMAIN", deviates: false } })).not.toContain("*")
    expect(status({})).not.toContain("preset:")
  })

  test("the context gauge stays hidden until usage is reported", () => {
    expect(status({})).not.toContain("ctx:")
    expect(status({ roomUsage: { tokens: 4100, hotPercent: null } })).toContain("ctx:")
    // No `·%` while hotPercent is null — room compaction has not defined a
    // threshold, so a percentage would be invented.
    expect(status({ roomUsage: { tokens: 4100, hotPercent: null } })).not.toContain("%")
    expect(status({ roomUsage: { tokens: 4100, hotPercent: 91 } })).toContain("91%")
  })

  test("draft routing is quiet on the common case and explicit when it matters", () => {
    expect(status({})).not.toContain("⏎⇒")
    const s = status({ draftTargets: { t: ["builder"], d: ["ghost"] } })
    expect(s).toContain("@builder")
    expect(s).toContain("ignored: @ghost")
    // A draft that reaches nobody must say so rather than render an empty slot —
    // a pasted transcript quoting @handles routes for real.
    expect(status({ draftTargets: { t: [], d: [] } })).toContain("nobody")
  })

  test("connection distinguishes reconnecting from a first connect", () => {
    expect(status({ connection: "connected" })).toContain("connected")
    expect(status({ connection: "reconnecting" })).toContain("reconnecting")
    expect(status({ connection: "connecting" })).toContain("connecting")
  })
})

describe("tabs", () => {
  test("a room with a running goal is dotted, so background rooms are visible", () => {
    expect(plain(at())[1]).toContain("● sub-room")
    expect(plain(at())[1]).not.toContain("● main-room")
  })

  test("the + tab swaps the hint to what ⏎ will do", () => {
    expect(plain(at())[1]).toContain("←→ switch")
    expect(plain(at({ plusSelected: true }))[1]).toContain("⏎ create / resume")
  })

  test("a long discussion title is truncated, not wrapped onto a second row", () => {
    const before = at().length
    const ls = at({ conversationTitle: "a".repeat(200) })
    expect(ls.length).toBe(before)
    expect(plain(ls)[1]).toContain("…")
  })

  test("no discussion yet shows a placeholder rather than an empty label", () => {
    expect(plain(at())[1]).toContain("💬 —")
  })
})
