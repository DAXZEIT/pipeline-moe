import { beforeAll, describe, expect, test } from "vitest"
import chalk from "chalk"
import type { Message, RosterItem, ToolActivity, TurnPart } from "@pipeline-moe/client-core"
import { transcriptLines, paint, type TranscriptInput } from "../transcript-lines.js"

// The flatten was inside Transcript.tsx and therefore untestable: asserting
// anything about it meant rendering React. Extracting it for the pi-tui client
// (docs/tui-pitui-migration-plan.md, Phase 0) made it a pure function, and this
// is the first thing that function owes us.
//
// The load-bearing assertion is APPEND-ONLY. The whole native-scrollback bet is
// that a line, once emitted, never changes as the turn grows — pi-tui answers a
// changed line above the viewport with a full redraw that clears the terminal's
// scrollback (`firstChanged < prevViewportTop`). The live probe
// (src/next/dev/probe-stability.ts) measures that against a real server; this
// measures it in CI, where a regression is cheap to catch.

const roster: RosterItem[] = [
  { id: "builder", name: "Builder", color: "#EF9F27", icon: "🔨", active: true } as RosterItem,
  { id: "scout", name: "Scout", color: "#4A90D9", icon: "🔍", active: true } as RosterItem,
]

const msg = (m: Partial<Message> & { index: number; author: string }): Message =>
  ({ authorName: m.author, text: "", ts: 0, ...m }) as Message

const act = (toolCallId: string, toolName: string, status: ToolActivity["status"] = "ok"): ToolActivity => ({
  toolCallId,
  toolName,
  status,
  ts: 0,
})

const state = (over: Partial<TranscriptInput> = {}): TranscriptInput => ({
  messages: [],
  roster,
  streaming: {},
  liveReasoning: {},
  liveActivity: {},
  reasoningActive: {},
  receipts: {},
  ...over,
})

const W = 80
const texts = (s: TranscriptInput, opts?: { showThoughts: boolean; showTools: boolean }): string[] =>
  transcriptLines(s, W, opts).lines.map((l) => l.text)

describe("append-only", () => {
  // Growth must EXTEND the array, never rewrite it. Assert prefix equality, not
  // "the last line changed" — a wrapping bug that reflows the paragraph above
  // would still pass the weaker check and would still clear the scrollback.
  const grows = (a: string[], b: string[]): void => {
    expect(b.length).toBeGreaterThanOrEqual(a.length)
    expect(b.slice(0, a.length)).toEqual(a)
  }

  test("streaming into a live block never disturbs the history above it", () => {
    // The in-flight paragraph rewrites its own last line on every token — that
    // is expected and harmless, it is on screen. What must NEVER move is
    // everything above the live header, because that is what has scrolled into
    // the terminal's scrollback and can no longer be repainted.
    const history = [
      msg({ index: 0, author: "user", text: "explain the seat runtime" }),
      msg({ index: 1, author: "builder", text: "It rebuilds the seat whenever the roster changes." }),
      msg({ index: 2, author: "user", text: "and the prompt?" }),
    ]
    const at = (chars: number): string[] =>
      texts(state({ messages: history, streaming: { scout: "word ".repeat(60).slice(0, chars) } }))
    const frozen = (ls: string[]): string[] => ls.slice(0, ls.findIndex((l) => l.includes("Scout")))

    const base = frozen(at(20))
    expect(base.length).toBeGreaterThan(3) // guard: the slice actually found the header
    for (const n of [40, 80, 160, 240, 300]) expect(frozen(at(n))).toEqual(base)
  })

  test("a finalized message is unchanged by later messages", () => {
    const one = texts(state({ messages: [msg({ index: 0, author: "user", text: "first question" })] }))
    const two = texts(
      state({
        messages: [
          msg({ index: 0, author: "user", text: "first question" }),
          msg({ index: 1, author: "builder", text: "an answer" }),
        ],
      }),
    )
    grows(one, two)
  })

  test("a live block appended below finalized history leaves it alone", () => {
    const history = [msg({ index: 0, author: "user", text: "go" }), msg({ index: 1, author: "builder", text: "done" })]
    const settled = texts(state({ messages: history }))
    const live = texts(state({ messages: history, streaming: { scout: "looking…" } }))
    grows(settled, live)
  })
})

describe("hasThoughts", () => {
  // The ⌃T hint is only honest when something can actually be folded.
  test("false with no reasoning anywhere", () => {
    expect(transcriptLines(state({ messages: [msg({ index: 0, author: "builder", text: "hi" })] }), W).hasThoughts).toBe(
      false,
    )
  })

  test("true for a persisted reasoning trace", () => {
    const s = state({ messages: [msg({ index: 0, author: "builder", text: "hi", reasoning: "because" })] })
    expect(transcriptLines(s, W).hasThoughts).toBe(true)
  })

  test("true for a reasoning SEGMENT of an interleaved turn", () => {
    // The grouped path sets it via pushThought; the chronological path goes
    // through pushReasoningSegment instead, and that one used to be easy to
    // forget — a turn with parts would advertise no ⌃T at all.
    const parts: TurnPart[] = [{ type: "reasoning", content: "weighing it", ts: 0 }, { type: "text", content: "ok", ts: 1 }]
    const s = state({ messages: [msg({ index: 0, author: "builder", text: "ok", parts })] })
    expect(transcriptLines(s, W).hasThoughts).toBe(true)
  })

  test("true while a live thought is streaming", () => {
    expect(transcriptLines(state({ liveReasoning: { builder: "hmm" } }), W).hasThoughts).toBe(true)
  })
})

describe("folding", () => {
  const reasoning = "a ".repeat(200)

  test("⌃T collapses a persisted thought to one line", () => {
    const s = state({ messages: [msg({ index: 0, author: "builder", text: "hi", reasoning })] })
    const open = texts(s, { showThoughts: true, showTools: false })
    const shut = texts(s, { showThoughts: false, showTools: false })
    expect(shut.length).toBeLessThan(open.length)
    expect(shut.filter((l) => l.startsWith("│ "))).toHaveLength(0)
    expect(shut.some((l) => /^💭 thought \(\d+ lines?\)$/.test(l))).toBe(true)
  })

  test("a collapsed LIVE thought still shows its tail, so you can watch it move", () => {
    const s = state({ liveReasoning: { builder: reasoning }, reasoningActive: { builder: true } })
    const shut = texts(s, { showThoughts: false, showTools: false })
    expect(shut).toContain("💭 thinking…")
    expect(shut.filter((l) => l.startsWith("│ "))).toHaveLength(2)
  })

  test("⌃O expands tool activity from a summary to one line per call", () => {
    const activity = [act("1", "read"), act("2", "read"), act("3", "bash")]
    const s = state({ messages: [msg({ index: 0, author: "builder", text: "done", activity })] })
    const folded = texts(s, { showThoughts: true, showTools: false })
    expect(folded.some((l) => l.includes("🔧 3 tool calls") && l.includes("ctrl+o"))).toBe(true)
    const open = texts(s, { showThoughts: true, showTools: true })
    expect(open.length).toBe(folded.length + activity.length)
  })

  test("an error survives folding — it is the one thing you must not hide", () => {
    const activity = [act("1", "read"), act("2", "bash", "error")]
    const s = state({ messages: [msg({ index: 0, author: "builder", text: "done", activity })] })
    expect(texts(s, { showThoughts: true, showTools: false }).some((l) => l.includes("1 ✗"))).toBe(true)
  })
})

describe("layout contracts", () => {
  test("parts render chronologically; the same turn without parts groups", () => {
    const parts: TurnPart[] = [
      { type: "reasoning", content: "check the file", ts: 0 },
      { type: "tool", toolCallId: "1" },
      { type: "text", content: "found it", ts: 2 },
    ]
    const activity = [act("1", "read")]
    const chrono = texts(state({ messages: [msg({ index: 0, author: "builder", text: "found it", parts, activity })] }))
    const iThought = chrono.findIndex((l) => l.startsWith("💭"))
    const iTool = chrono.findIndex((l) => l.includes("read"))
    const iText = chrono.findIndex((l) => l.includes("found it"))
    expect(iThought).toBeGreaterThanOrEqual(0)
    expect(iTool).toBeGreaterThan(iThought)
    expect(iText).toBeGreaterThan(iTool)

    // No parts (an entry recorded before the server segmented turns): grouped,
    // and the tool block precedes the prose regardless of when it happened.
    const grouped = texts(
      state({ messages: [msg({ index: 0, author: "builder", text: "found it", reasoning: "check the file", activity })] }),
    )
    expect(grouped.some((l) => l.includes("🔧 1 tool call"))).toBe(true)
  })

  test("prose drawn as a text segment is not drawn twice from m.text", () => {
    // m.text is a COMPOSED body once a turn has parts; re-rendering it would
    // duplicate the reply under itself.
    const parts: TurnPart[] = [{ type: "text", content: "the answer", ts: 0 }]
    const out = texts(state({ messages: [msg({ index: 0, author: "builder", text: "the answer", parts })] }))
    expect(out.filter((l) => l.includes("the answer"))).toHaveLength(1)
  })

  test("only the live header carries the streaming cursor", () => {
    const s = state({
      messages: [msg({ index: 0, author: "builder", text: "done" })],
      streaming: { scout: "still going" },
    })
    const cursors = transcriptLines(s, W).lines.filter((l) => l.cursor)
    expect(cursors).toHaveLength(1)
    expect(cursors[0]!.text).toContain("Scout")
  })

  test("an empty live buffer produces no block at all", () => {
    expect(texts(state({ streaming: { builder: "" }, liveActivity: { builder: [] } }))).toHaveLength(0)
  })

  test("a question and its options survive into the scrollback", () => {
    const out = texts(
      state({
        messages: [msg({ index: 0, author: "builder", text: "", question: "which one?", questionOptions: ["a", "b"] })],
      }),
    )
    expect(out.some((l) => l.includes("🤚 which one?"))).toBe(true)
    expect(out.some((l) => l.includes("1 a"))).toBe(true)
    expect(out.some((l) => l.includes("2 b"))).toBe(true)
    // …and it must NOT also claim the turn produced nothing.
    expect(out).not.toContain("(no response)")
  })

  test("a handoff is shown, since a tool-only handoff is invisible in the text", () => {
    const out = texts(state({ messages: [msg({ index: 0, author: "builder", text: "ok", handoffTo: "scout" })] }))
    expect(out).toContain("↪ handoff → @scout")
  })

  test("user and shell text is never markdown-rendered", () => {
    // '# comment' in a shell log must not become a heading.
    const out = texts(
      state({ messages: [msg({ index: 0, author: "shell", authorName: "shell", text: "# not a heading\n$ ls -la" })] }),
    )
    expect(out).toContain("# not a heading")
    expect(out).toContain("$ ls -la")
  })

  // KNOWN DEFECT, pre-existing and deliberately preserved by the extraction.
  // `wrap()` splits on " " and rejoins with single spaces, so leading
  // indentation is destroyed — which is exactly what the shell-output comment
  // above it claims markdown would do. Verified byte-identical to the wrap that
  // shipped in Transcript.tsx, so it is NOT a migration regression, and the
  // migration's rule is that a phase is a translation and never an improvement.
  // Asserted so the day someone fixes it, they see this test and know it was
  // known. Fix belongs after Phase 6, with the web renderer checked too.
  test("indentation is currently LOST by the wrapper (known defect)", () => {
    const out = texts(state({ messages: [msg({ index: 0, author: "shell", authorName: "shell", text: "    indented" })] }))
    expect(out).toContain("indented")
    expect(out).not.toContain("    indented")
  })

  test("width is respected by the wrapper, including an unbreakable word", () => {
    const long = "x".repeat(300)
    const out = texts(state({ messages: [msg({ index: 0, author: "user", text: long })] }))
    for (const l of out) expect(l.length).toBeLessThanOrEqual(W)
  })
})

describe("paint", () => {
  // Under vitest, stdout is not a TTY, so chalk auto-detects level 0 and emits
  // no escapes at all. Force truecolor: the assertions here are about which
  // chalk PATH a Line takes, which is invisible when everything is plain.
  beforeAll(() => {
    chalk.level = 3
  })

  test("hex colours go through chalk.hex, named through chalk[name]", () => {
    expect(paint({ text: "x", color: "#EF9F27" })).toContain("\x1b[38;2;239;159;39m")
    expect(paint({ text: "x", color: "red" })).toContain("\x1b[31m")
  })

  test("an unknown colour name degrades to plain text instead of throwing", () => {
    expect(paint({ text: "x", color: "chartreuse" })).toBe("x")
  })

  test("an empty line stays empty — no stray reset sequences to diff against", () => {
    expect(paint({ text: "", bold: true, color: "red" })).toBe("")
  })
})
