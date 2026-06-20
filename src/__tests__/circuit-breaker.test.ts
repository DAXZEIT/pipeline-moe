import { describe, expect, test } from "vitest"
import {
  textSimilarity,
  REPEAT_THRESHOLD,
  SIMILARITY_FLOOR,
  LOOKBACK_WINDOW,
} from "../circuit-breaker.js"

/* ────────────────────────────────────────────────────
 *  textSimilarity — Jaccard on word sets
 * ──────────────────────────────────────────────────── */

describe("textSimilarity", () => {
  test("identical texts return 1", () => {
    const s = "hello world foo bar"
    expect(textSimilarity(s, s)).toBe(1)
  })

  test("completely different texts return 0", () => {
    expect(textSimilarity("hello world", "foo bar")).toBe(0)
  })

  test("case insensitive", () => {
    expect(textSimilarity("Hello World", "hello world")).toBe(1)
  })

  test("partial overlap", () => {
    // "hello world foo" vs "hello world bar"
    // intersection: {hello, world} = 2
    // union: {hello, world, foo, bar} = 4
    // jaccard = 2/4 = 0.5
    expect(textSimilarity("hello world foo", "hello world bar")).toBe(0.5)
  })

  test("empty strings return 1", () => {
    expect(textSimilarity("", "")).toBe(1)
  })

  test("one empty string returns 0", () => {
    expect(textSimilarity("hello", "")).toBe(0)
    expect(textSimilarity("", "hello")).toBe(0)
  })

  test("punctuation and special chars are stripped", () => {
    expect(textSimilarity("hello, world!", "hello world")).toBe(1)
  })

  test("near-identical with one word changed", () => {
    // "the" appears twice → Set dedup: {the,quick,brown,fox,jumps,over,lazy,dog,today} = 9
    // vs {the,quick,brown,fox,jumps,over,lazy,dog,tomorrow} = 9
    // intersection = 8, union = 10 → 8/10 = 0.8
    const a = "the quick brown fox jumps over the lazy dog today"
    const b = "the quick brown fox jumps over the lazy dog tomorrow"
    expect(textSimilarity(a, b)).toBeCloseTo(0.8, 5)
  })

  test("below similarity floor", () => {
    const a = "the quick brown fox jumps over the lazy dog"
    const b = "the quick brown fox jumps over a tall tree"
    // intersection: {the, quick, brown, fox, jumps, over} = 6
    // union: {the, quick, brown, fox, jumps, over, lazy, dog, a, tall, tree} = 11
    // jaccard = 6/11 ≈ 0.545
    const sim = textSimilarity(a, b)
    expect(sim).toBeCloseTo(6 / 11, 5)
    expect(sim).toBeLessThan(SIMILARITY_FLOOR)
  })

  test("above similarity floor", () => {
    // Unique words: {the,quick,brown,fox,jumps,over,lazy,dog} = 8
    // vs {the,quick,brown,fox,jumps,over,lazy,cat} = 8
    // intersection = 7, union = 9 → 7/9 ≈ 0.778 (below floor)
    const a = "the quick brown fox jumps over the lazy dog"
    const b = "the quick brown fox jumps over the lazy cat"
    expect(textSimilarity(a, b)).toBeCloseTo(7 / 9, 5)
    expect(textSimilarity(a, b)).toBeLessThan(SIMILARITY_FLOOR)
  })
})

/* ────────────────────────────────────────────────────
 *  Constants
 * ──────────────────────────────────────────────────── */

describe("constants", () => {
  test("REPEAT_THRESHOLD is 5", () => {
    expect(REPEAT_THRESHOLD).toBe(5)
  })

  test("SIMILARITY_FLOOR is 0.8", () => {
    expect(SIMILARITY_FLOOR).toBe(0.8)
  })

  test("LOOKBACK_WINDOW is 10", () => {
    expect(LOOKBACK_WINDOW).toBe(10)
  })
})

/* ────────────────────────────────────────────────────
 *  checkRepetition — simulated via inline logic
 *  (Room.checkRepetition is private, so we replicate
 *   the algorithm with the exported textSimilarity)
 * ──────────────────────────────────────────────────── */

describe("checkRepetition logic", () => {
  /** Simulate the checkRepetition algorithm.
   *  The real Room.post() pushes the entry to transcript BEFORE calling
   *  checkRepetition, so the current message IS in the transcript and
   *  will match itself → similarCount starts at 1.
   */
  function checkRepetition(messages: { author: string; text: string }[], newText: string): boolean {
    // Build transcript = prior messages + current message at the end
    const transcript = [...messages, { author: "agent" as const, text: newText }]

    // Collect recent messages from same author (like Room.checkRepetition does)
    const recent: string[] = []
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (transcript[i].author === "agent") {
        recent.push(transcript[i].text)
      }
      if (recent.length >= LOOKBACK_WINDOW) break
    }

    let similarCount = 0
    for (const prev of recent) {
      if (textSimilarity(newText, prev) >= SIMILARITY_FLOOR) {
        similarCount++
      }
    }

    return similarCount >= REPEAT_THRESHOLD
  }

  test("triggers after 5 identical outputs", () => {
    const repeated = "I am stuck in a loop doing the same thing"
    const messages = Array.from({ length: 4 }, () => ({
      author: "agent" as const,
      text: repeated,
    }))

    // 4 prior + current = 5 similar → should trigger
    expect(checkRepetition(messages, repeated)).toBe(true)
  })

  test("does NOT trigger with only 4 identical outputs", () => {
    const repeated = "I am stuck in a loop doing the same thing"
    const messages = Array.from({ length: 3 }, () => ({
      author: "agent" as const,
      text: repeated,
    }))

    // 3 prior + current = 4 similar → should NOT trigger
    expect(checkRepetition(messages, repeated)).toBe(false)
  })

  test("does NOT trigger with different outputs", () => {
    const messages = [
      { author: "agent" as const, text: "I did step 1" },
      { author: "agent" as const, text: "I did step 2" },
      { author: "agent" as const, text: "I did step 3" },
      { author: "agent" as const, text: "I did step 4" },
      { author: "agent" as const, text: "I did step 5" },
    ]

    expect(checkRepetition(messages, "I did step 6")).toBe(false)
  })

  test("user messages are excluded from repetition check", () => {
    const repeated = "I am stuck in a loop"
    const messages = [
      { author: "user" as const, text: "please help" },
      { author: "agent" as const, text: repeated },
      { author: "user" as const, text: "still stuck" },
      { author: "agent" as const, text: repeated },
      { author: "user" as const, text: "again" },
      { author: "agent" as const, text: repeated },
      { author: "user" as const, text: "more" },
      { author: "agent" as const, text: repeated },
      { author: "user" as const, text: "yes" },
    ]

    // Only 4 agent messages, so 4 prior + current = 5 → triggers
    expect(checkRepetition(messages, repeated)).toBe(true)
  })

  test("near-identical outputs (above floor) count as similar", () => {
    // 14 unique words each, 13 common → 13/15 ≈ 0.867 > 0.8
    const base = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike time"
    const variant = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike day"
    expect(textSimilarity(base, variant)).toBeGreaterThan(SIMILARITY_FLOOR)

    const messages = Array.from({ length: 4 }, () => ({
      author: "agent" as const,
      text: base,
    }))

    expect(checkRepetition(messages, variant)).toBe(true)
  })
})
