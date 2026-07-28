import { describe, expect, test } from "vitest"
import type { ToolActivity, TurnPart } from "../types.js"
import { summarizeArgs, toSegments } from "../parts.js"

// docs/interleaved-turns.md — the reduction both clients apply to a turn's
// chronological parts before anything is drawn. What is asserted here is
// exactly what a screenshot cannot check cheaply: that ORDER survives, and
// that aggregation never invents adjacency.

const tool = (toolCallId: string): TurnPart => ({ type: "tool", toolCallId })
const say = (type: "reasoning" | "text", content: string): TurnPart => ({ type, content, ts: 0 })

const act = (toolCallId: string, toolName: string, status: ToolActivity["status"] = "ok"): ToolActivity => ({
  toolCallId,
  toolName,
  status,
  ts: 0,
})

/** Compact shape, for assertions about order. */
const shape = (segs: ReturnType<typeof toSegments>) =>
  segs.map((s) => (s.kind === "tools" ? `${s.group.toolName}×${s.group.items.length}` : s.kind[0])).join(" ")

describe("toSegments", () => {
  test("keeps the turn's order and resolves tool pointers", () => {
    const parts = [say("reasoning", "check it"), tool("c1"), say("reasoning", "again"), tool("c2"), say("text", "done")]
    const activity = [act("c1", "read"), act("c2", "grep")]
    expect(shape(toSegments(parts, activity))).toBe("r read×1 r grep×1 t")
  })

  test("consecutive same-tool ok calls still aggregate", () => {
    // Six reads in a row with no thought between them are six rows of noise
    // in an interleaved view; they are one ×6 group, exactly as before.
    const parts = [say("reasoning", "read them all"), tool("c1"), tool("c2"), tool("c3"), say("text", "ok")]
    const activity = [act("c1", "read"), act("c2", "read"), act("c3", "read")]
    expect(shape(toSegments(parts, activity))).toBe("r read×3 t")
  })

  test("an error never merges into a neighbouring group", () => {
    const parts = [tool("c1"), tool("c2"), tool("c3")]
    const activity = [act("c1", "read"), act("c2", "read", "error"), act("c3", "read")]
    expect(shape(toSegments(parts, activity))).toBe("read×1 read×1 read×1")
    expect(toSegments(parts, activity)[1]).toMatchObject({ kind: "tools", group: { status: "error" } })
  })

  test("aggregation never reaches across a thought", () => {
    // The whole point of the layout: two reads with a thought between them are
    // two moments, not one ×2 burst.
    const parts = [tool("c1"), say("reasoning", "hm"), tool("c2")]
    const activity = [act("c1", "read"), act("c2", "read")]
    expect(shape(toSegments(parts, activity))).toBe("read×1 r read×1")
  })

  test("an unresolved tool part is dropped, not drawn as a placeholder", () => {
    const parts = [say("text", "hi"), tool("missing")]
    expect(shape(toSegments(parts, []))).toBe("t")
  })

  test("empty segments are skipped — a live run is not trimmed at the source", () => {
    const parts = [say("reasoning", "  \n "), say("text", "real")]
    expect(shape(toSegments(parts, []))).toBe("t")
  })
})

// A summary that is not one line is not a summary — and in the TUI it is a
// corrupted frame. dax hit this live on 2026-07-28: a seat ran a heredoc, the
// bash line carried its newlines into the transcript, and the status bar
// ("room:… msgs:…") started appearing in the middle of the conversation
// because every row below the tool line was diffed against the wrong index.
describe("summarizeArgs is single-line", () => {
  const withArgs = (args: Record<string, unknown>): ToolActivity => ({
    toolCallId: "c1",
    toolName: "bash",
    status: "ok",
    ts: 0,
    args,
  })

  test("a multi-line command collapses to one line", () => {
    const s = summarizeArgs(withArgs({ command: "node - <<'EOF'\nconsole.log(1)\nEOF" }))
    expect(s).not.toMatch(/[\r\n]/)
    expect(s).toBe("node - <<'EOF' console.log(1) EOF")
  })

  test("CRLF and tabs collapse too", () => {
    expect(summarizeArgs(withArgs({ command: "a\r\n\tb" }))).toBe("a b")
  })

  test("the JSON fallback is flattened as well", () => {
    // No command/path/pattern/question key, so it stringifies - and a newline
    // inside a value survives JSON.stringify as an escape, but one inside a KEY
    // or a pretty-printed payload would not.
    const s = summarizeArgs(withArgs({ payload: "x", note: "l1\nl2" }))
    expect(s).not.toMatch(/[\r\n]/)
  })

  test("ask_user reads as its question, not as escaped JSON", () => {
    const s = summarizeArgs({
      toolCallId: "c2",
      toolName: "ask_user",
      status: "ok",
      ts: 0,
      args: { question: "How do you want to close this out?", options: ["stop", "retry"] },
    })
    expect(s).toBe("How do you want to close this out?")
  })
})
