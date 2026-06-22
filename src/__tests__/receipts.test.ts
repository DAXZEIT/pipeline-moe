import { expect, test } from "vitest"
import { diffSnapshots, receiptFromActivity, receiptHasChanges, type Snapshot } from "../receipts.js"
import type { ToolActivity } from "../types.js"

const mk = (entries: [string, string][]): Snapshot => new Map(entries)

test("diffSnapshots — detects created files", () => {
  const before = mk([])
  const after = mk([["a.txt", "100:1000"]])
  const r = diffSnapshots(before, after, "agent-1")
  expect(r.created).toEqual(["a.txt"])
  expect(r.modified).toEqual([])
  expect(r.deleted).toEqual([])
})

test("diffSnapshots — detects modified files", () => {
  const before = mk([["a.txt", "100:1000"]])
  const after = mk([["a.txt", "200:2000"]])
  const r = diffSnapshots(before, after, "agent-1")
  expect(r.created).toEqual([])
  expect(r.modified).toEqual(["a.txt"])
  expect(r.deleted).toEqual([])
})

test("diffSnapshots — detects deleted files", () => {
  const before = mk([["a.txt", "100:1000"]])
  const after = mk([])
  const r = diffSnapshots(before, after, "agent-1")
  expect(r.created).toEqual([])
  expect(r.modified).toEqual([])
  expect(r.deleted).toEqual(["a.txt"])
})

test("diffSnapshots — mixed changes", () => {
  const before = mk([["a.txt", "100:1000"], ["b.txt", "50:500"]])
  const after = mk([["a.txt", "200:2000"], ["c.txt", "30:300"]])
  const r = diffSnapshots(before, after, "agent-1")
  expect(r.created).toEqual(["c.txt"])
  expect(r.modified).toEqual(["a.txt"])
  expect(r.deleted).toEqual(["b.txt"])
})

test("diffSnapshots — no changes", () => {
  const before = mk([["a.txt", "100:1000"]])
  const after = mk([["a.txt", "100:1000"]])
  const r = diffSnapshots(before, after, "agent-1")
  expect(r.created).toEqual([])
  expect(r.modified).toEqual([])
  expect(r.deleted).toEqual([])
})

test("diffSnapshots — results are sorted", () => {
  const before = mk([])
  const after = mk([["z.txt", "1:1"], ["a.txt", "1:1"], ["m.txt", "1:1"]])
  const r = diffSnapshots(before, after, "agent-1")
  expect(r.created).toEqual(["a.txt", "m.txt", "z.txt"])
})

test("receiptHasChanges — true when there are changes", () => {
  expect(receiptHasChanges({ participantId: "x", created: ["a"], modified: [], deleted: [] })).toBe(true)
  expect(receiptHasChanges({ participantId: "x", created: [], modified: ["a"], deleted: [] })).toBe(true)
  expect(receiptHasChanges({ participantId: "x", created: [], modified: [], deleted: ["a"] })).toBe(true)
})

test("receiptHasChanges — false when no changes", () => {
  expect(receiptHasChanges({ participantId: "x", created: [], modified: [], deleted: [] })).toBe(false)
})

test("participantId is preserved", () => {
  const r = diffSnapshots(mk([]), mk([["a.txt", "1:1"]]), "builder-42")
  expect(r.participantId).toBe("builder-42")
})

// ── receiptFromActivity (remote rooms) ──────────────────────────────────────

const act = (toolName: string, args: unknown, status: ToolActivity["status"] = "ok"): ToolActivity => ({
  toolCallId: Math.random().toString(36).slice(2),
  toolName,
  args,
  status,
  ts: Date.now(),
})

test("receiptFromActivity — collects write/edit paths (tolerates the path key)", () => {
  const r = receiptFromActivity(
    [
      act("write", { file_path: "src/a.ts", content: "..." }),
      act("edit", { path: "src/b.ts" }),
      act("read", { file_path: "src/c.ts" }), // read doesn't mutate
      act("bash", { command: "python run.py" }), // bash side-effects not captured
    ],
    "builder",
  )
  expect(r.modified).toEqual(["src/a.ts", "src/b.ts"])
  expect(r.created).toEqual([])
  expect(r.deleted).toEqual([])
  expect(receiptHasChanges(r)).toBe(true)
})

test("receiptFromActivity — ignores failed tool calls and de-dupes", () => {
  const r = receiptFromActivity(
    [
      act("write", { file_path: "src/a.ts" }, "error"), // failed → didn't change disk
      act("edit", { file_path: "src/a.ts" }), // same file edited again → once
      act("edit", { file_path: "src/a.ts" }),
    ],
    "builder",
  )
  expect(r.modified).toEqual(["src/a.ts"])
})

test("receiptFromActivity — no file ops yields an empty receipt", () => {
  const r = receiptFromActivity([act("read", { file_path: "x" }), act("grep", { pattern: "y" })], "scout")
  expect(receiptHasChanges(r)).toBe(false)
})
