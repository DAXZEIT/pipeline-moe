import { Marked, type MarkedExtension } from "marked"
import { markedTerminal } from "marked-terminal"
import wrapAnsi from "wrap-ansi"

/**
 * Markdown → ANSI display lines for the transcript. The renderer is given the
 * transcript's text width so marked-terminal reflows paragraphs itself — the
 * returned lines are final display lines that slot straight into the
 * Transcript's line-accurate windowing.
 *
 * Two entry points share the pipeline but not their caches:
 * - renderMarkdownLines: completed messages. Immutable once finalized and
 *   re-rendered every streaming tick, so results are cached per text.
 * - renderStreamingMarkdownLines: in-flight buffers. Incomplete markdown is
 *   safe to parse — CommonMark runs an unclosed code fence to end-of-input, so
 *   code starts highlighting as soon as the fence opens, and an unclosed
 *   `**`/backtick just stays literal until its closer streams in. Buffers are
 *   ever-growing prefixes though, so they get their own small cache (a hit
 *   only means a re-render tick with no new tokens) — caching them alongside
 *   completed messages would churn that cache out constantly.
 *
 * Both caches drop when the terminal width changes.
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

/** Run a sync fn with the console muted. highlight.js console.error()s on an
 *  unknown code-fence language before throwing — which happens legitimately
 *  ("```mermaid", or "```t" while "```ts" is still streaming in) — and under
 *  Ink any console output tears into the rendered frame. */
function quietly<T>(fn: () => T): T {
  const { error, warn, log } = console
  console.error = console.warn = console.log = () => {}
  try {
    return fn()
  } finally {
    console.error = error
    console.warn = warn
    console.log = log
  }
}

/** Parse + post-wrap, uncached. Null when marked throws (caller falls back to
 *  plain word-wrapping). */
function render(text: string, width: number): string[] | null {
  try {
    const out = quietly(() => parserFor(width).parse(text, { async: false }) as string)
    // marked-terminal only reflows paragraphs — list items, headings, code and
    // tables can come back as one over-wide line. Re-wrap those ANSI-aware
    // (wrap-ansi carries the open style codes onto the continuation lines)
    // instead of letting the Transcript truncate content away.
    const lines: string[] = []
    for (const raw of out.replace(/\n+\s*$/, "").split("\n")) {
      for (const l of wrapAnsi(raw, width, { hard: true, trim: false }).split("\n")) lines.push(l)
    }
    return lines
  } catch {
    return null
  }
}

let cacheWidth = -1
const cache = new Map<string, string[] | null>()
const streamCache = new Map<string, string[] | null>()

function resetOnResize(width: number) {
  if (width !== cacheWidth) {
    cache.clear()
    streamCache.clear()
    cacheWidth = width
  }
}

/** Render a completed message's markdown to styled display lines. */
export function renderMarkdownLines(text: string, width: number): string[] | null {
  resetOnResize(width)
  const hit = cache.get(text)
  if (hit !== undefined) return hit
  const lines = render(text, width)
  if (cache.size >= 500) cache.clear()
  cache.set(text, lines)
  return lines
}

/** Render an in-flight streaming buffer's markdown to styled display lines. */
export function renderStreamingMarkdownLines(text: string, width: number): string[] | null {
  resetOnResize(width)
  const hit = streamCache.get(text)
  if (hit !== undefined) return hit
  const lines = render(text, width)
  if (streamCache.size >= 16) streamCache.clear()
  streamCache.set(text, lines)
  return lines
}
