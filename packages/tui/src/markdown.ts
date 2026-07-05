import { Marked, type MarkedExtension } from "marked"
import { markedTerminal } from "marked-terminal"
import wrapAnsi from "wrap-ansi"

/**
 * Markdown → ANSI display lines for the transcript (Tier 0: completed messages
 * only; in-flight streaming stays raw so half-open code fences can't break the
 * parser). The renderer is given the transcript's text width so marked-terminal
 * reflows paragraphs itself — the returned lines are final display lines that
 * slot straight into the Transcript's line-accurate windowing. Blocks that
 * don't reflow (code, tables) may exceed the width; the Transcript truncates
 * those rather than letting Ink re-wrap them and break the line accounting.
 *
 * Results are cached per message text: messages are immutable once finalized
 * and the Transcript re-renders on every streaming tick, so parsing must not
 * repeat. The cache is dropped when the terminal width changes.
 */

const parsers = new Map<number, Marked>()

function parserFor(width: number): Marked {
  let m = parsers.get(width)
  if (!m) {
    m = new Marked()
    m.use(markedTerminal({ width, reflowText: true, tab: 2 }) as MarkedExtension)
    // marked-terminal's `text` renderer returns token.text — the raw source —
    // so inline markdown inside tight list items (`code`, *em*, **bold**)
    // leaks through unparsed. Registered after markedTerminal so it wins.
    m.use({
      renderer: {
        text(token) {
          return "tokens" in token && token.tokens ? this.parser.parseInline(token.tokens) : token.text
        },
      },
    })
    parsers.set(width, m)
  }
  return m
}

let cacheWidth = -1
const cache = new Map<string, string[] | null>()

/** Render markdown to styled display lines, or null if parsing fails
 *  (the caller falls back to plain word-wrapping). */
export function renderMarkdownLines(text: string, width: number): string[] | null {
  if (width !== cacheWidth) {
    cache.clear()
    cacheWidth = width
  }
  const hit = cache.get(text)
  if (hit !== undefined) return hit

  let lines: string[] | null
  try {
    const out = parserFor(width).parse(text, { async: false }) as string
    // marked-terminal only reflows paragraphs — list items, headings, code and
    // tables can come back as one over-wide line. Re-wrap those ANSI-aware
    // (wrap-ansi carries the open style codes onto the continuation lines)
    // instead of letting the Transcript truncate content away.
    lines = []
    for (const raw of out.replace(/\n+\s*$/, "").split("\n")) {
      for (const l of wrapAnsi(raw, width, { hard: true, trim: false }).split("\n")) lines.push(l)
    }
  } catch {
    lines = null
  }
  if (cache.size >= 500) cache.clear()
  cache.set(text, lines)
  return lines
}
