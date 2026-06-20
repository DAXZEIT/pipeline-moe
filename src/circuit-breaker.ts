/**
 * Circuit breaker — detect when an agent repeats the same output N times
 * in the shared transcript and automatically abort the pipeline.
 *
 * Detection uses Jaccard similarity on normalized word sets.
 * Loops produce near-identical output, not subtle paraphrases —
 * a simple set intersection is sufficient.
 */

/** How many similar outputs from the same agent trigger the breaker. */
export const REPEAT_THRESHOLD = 5

/** Minimum Jaccard similarity to count as "similar". */
export const SIMILARITY_FLOOR = 0.8

/** Look back this many messages from the same author when checking. */
export const LOOKBACK_WINDOW = 10

/**
 * Compute Jaccard similarity between two texts.
 * Normalizes by lowercasing and splitting on non-word boundaries.
 */
export function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalize(a))
  const wordsB = new Set(normalize(b))

  if (wordsA.size === 0 && wordsB.size === 0) return 1
  if (wordsA.size === 0 || wordsB.size === 0) return 0

  let intersection = 0
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++
  }

  const union = wordsA.size + wordsB.size - intersection
  return intersection / union
}

/** Normalize text: lowercase, extract word tokens (alphabetic + digits). */
function normalize(text: string): string[] {
  return text.toLowerCase().match(/\b[\w]+\b/g) ?? []
}

// ── Tool-call loop detection ─────────────────────────────────────────────────

import type { ToolActivity, TranscriptEntry } from "./types.js"

/** How many identical tool-call signatures trigger the tool-loop breaker. */
export const TOOL_REPEAT_THRESHOLD = 3

/**
 * Build a fingerprint from a tool call: toolName + discriminating args.
 * - Edit: toolName + path + oldText
 * - Bash: toolName + command
 * - Read/Write/Grep/find: toolName + path
 * - Everything else: toolName + JSON(args)
 */
export function toolCallSignature(tc: ToolActivity): string {
  const name = tc.toolName.toLowerCase()
  const a = tc.args as Record<string, unknown> | undefined
  if (!a) return name

  const path = String(a.file_path ?? a.path ?? a.file ?? "").trim()

  switch (name) {
    case "edit":
      return `${name}|${path}|${String(a.old_string ?? a.oldText ?? "").trim()}`
    case "bash":
      return `${name}|${String(a.command ?? "").trim()}`
    case "read":
    case "write":
    case "grep":
    case "find":
    case "glob":
      return `${name}|${path}`
    default:
      try { return `${name}|${JSON.stringify(a)}` } catch { return name }
  }
}

/**
 * Check if tool calls from the current turn + recent transcript entries
 * contain a repeated signature >= TOOL_REPEAT_THRESHOLD times.
 *
 * Returns the tripped signature and count, or { tripped: false }.
 */
export function checkToolLoop(
  transcript: TranscriptEntry[],
  author: string,
  currentActivity: ToolActivity[],
): { tripped: boolean; signature?: string; count?: number } {
  // Collect all tool-call signatures: current turn + recent same-author entries
  const signatures: string[] = []

  // Current turn's calls
  for (const tc of currentActivity) {
    signatures.push(toolCallSignature(tc))
  }

  // Recent transcript entries from same author
  let seen = 0
  for (let i = transcript.length - 1; i >= 0 && seen < LOOKBACK_WINDOW; i--) {
    const entry = transcript[i]
    if (entry.author !== author) continue
    seen++
    if (entry.activity) {
      for (const tc of entry.activity) {
        signatures.push(toolCallSignature(tc))
      }
    }
  }

  // Count occurrences
  const counts = new Map<string, number>()
  for (const sig of signatures) {
    const c = (counts.get(sig) ?? 0) + 1
    counts.set(sig, c)
    if (c >= TOOL_REPEAT_THRESHOLD) {
      return { tripped: true, signature: sig, count: c }
    }
  }

  return { tripped: false }
}
