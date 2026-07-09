import { describe, expect, test } from "vitest"
import { extractPauseQuestion } from "../participant.js"
import type { ToolActivity } from "../types.js"

// The pause-question extractor: pulls ask_user/ask_orchestrator questions out
// of a turn's activity, with the QCM `options` sanitized so a model passing
// garbage degrades to a plain free-text question — never a broken picker.

const act = (over: Partial<ToolActivity>): ToolActivity => ({
  toolCallId: "t1",
  toolName: "ask_user",
  status: "ok",
  ts: 0,
  ...over,
})

describe("extractPauseQuestion", () => {
  test("plain question, no options", () => {
    expect(extractPauseQuestion([act({ args: { question: "Which?" } })])).toEqual({ question: "Which?" })
  })

  test("question with options, trimmed and capped at 6", () => {
    const options = ["a ", " b", "c", "d", "e", "f", "g", "h"]
    expect(extractPauseQuestion([act({ args: { question: "Pick", options } })])).toEqual({
      question: "Pick",
      options: ["a", "b", "c", "d", "e", "f"],
    })
  })

  test("garbage options degrade to a plain question — numbers, empties, non-array", () => {
    expect(extractPauseQuestion([act({ args: { question: "Q", options: [1, "", "  ", null] } })])).toEqual({
      question: "Q",
      options: undefined,
    } as never)
    expect(extractPauseQuestion([act({ args: { question: "Q", options: "not-an-array" } })])).toEqual({ question: "Q" })
  })

  test("failed or non-ask tool calls are ignored; ask_orchestrator also pauses", () => {
    expect(extractPauseQuestion([act({ status: "error", args: { question: "Q" } })])).toBeNull()
    expect(extractPauseQuestion([act({ toolName: "read", args: { question: "Q" } })])).toBeNull()
    expect(extractPauseQuestion([act({ toolName: "ask_orchestrator", args: { question: "Boss?" } })])).toEqual({
      question: "Boss?",
    })
  })

  test("no question arg → keeps scanning, null when nothing matches", () => {
    expect(extractPauseQuestion([act({ args: {} }), act({ args: { question: "Late" } })])).toEqual({
      question: "Late",
    })
    expect(extractPauseQuestion([])).toBeNull()
  })
})
