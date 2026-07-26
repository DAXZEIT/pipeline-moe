// Images in the transcript — the one thing this migration ADDS rather than ports.
//
// `/image ~/shot.png` and ⌃V have worked for months: the file is base64'd, posted,
// saved by the server under `media/<hash>.png`, and handed to a vision model. What
// the Ink client could never do is SHOW it. Its transcript is a grid of characters,
// so an attachment rendered as `📎 1 image` and the user's only way to see what
// they had just sent was to open it in another program.
//
// pi-tui carries the kitty and iTerm2 graphics protocols, including the part that
// is actually hard: reserved-row bookkeeping inside the frame diff
// (`getKittyImageReservedRows`, `expandChangedRangeForKittyImages`). An image is
// `rows` lines tall, the first carrying the escape sequence and the rest blank, and
// the differ knows not to overwrite the block when a neighbouring line changes.
// Emitting that shape is all this module does; the protocol work is theirs.
//
// TWO THINGS TO KNOW, both measured rather than assumed:
//
//   - IMAGE LINES ARE EXEMPT from the width invariant (`isImageLine(line)` guards
//     the throw in tui.js), and they MUST NOT be touched by the transcript's
//     `" " + truncateToWidth(...)` — a prefix or a truncation inside the sequence
//     corrupts the payload. They leave this module ready to print, and the
//     transcript component passes them through untouched.
//   - AN IMAGE THAT WOULD NOT FIT THE VIEWPORT COSTS A FULL REDRAW. pi-tui checks
//     whether the block fits before pre-clearing its rows and falls back to a full
//     render when it does not ("kitty image pre-clear would scroll"). That is
//     inherent — the block has to be placed atomically — which is why images are
//     capped at 16 rows here: a tall block that never fits would redraw on every
//     frame, and one that fits costs nothing.
//
// Terminals with no graphics protocol keep the `📎 N images` line, unchanged, which
// is also what Ink shows.

import chalk from "chalk"
import { Image, getCapabilities } from "@earendil-works/pi-tui"

/** Cells tall an attachment may occupy. Enough to recognise a screenshot,
 *  small enough that a block always fits a normal window (see the full-redraw
 *  note above). */
const MAX_ROWS = 16
/** Cells wide. Independent of the terminal so a wide window does not blow the
 *  image up to 200 columns of pixels. */
const MAX_COLS = 48

const THEME = { fallbackColor: (s: string) => chalk.dim(s) }

type Entry =
  | { state: "loading" }
  | { state: "ready"; image: Image }
  | { state: "failed"; why: string }

export interface ImageStripDeps {
  apiBase: string
  /** A fetch that lands after the frame it was needed for has to ask for another. */
  requestRender: () => void
}

/**
 * Resolves the `media/<file>` paths a message carries into printable rows, caching
 * both the bytes and pi-tui's `Image` (which caches its own encoded lines). The
 * cache is why this is a class: the transcript returns EVERY line every frame, so
 * an image the differ has already seen must come back as the same string — same
 * reference, compared in O(1), no re-encode of a megabyte of base64 per token.
 */
export class ImageStrip {
  private cache = new Map<string, Entry>()

  constructor(private deps: ImageStripDeps) {}

  /** Whether this terminal can draw at all. Checked once per frame by the caller,
   *  so a terminal without graphics never pays for a fetch. */
  static supported(): boolean {
    return getCapabilities().images !== null
  }

  /** Printable rows for one message's attachments, or `null` when there is nothing
   *  to draw yet and the caller should keep its `📎` line. */
  lines(paths: string[], width: number): string[] | null {
    if (!ImageStrip.supported()) return null
    const out: string[] = []
    let drew = false
    for (const path of paths) {
      const entry = this.entry(path)
      if (entry.state === "ready") {
        out.push(...entry.image.render(Math.min(width, MAX_COLS + 2)))
        drew = true
      } else if (entry.state === "failed") {
        out.push(chalk.dim(`📎 ${basename(path)} — ${entry.why}`))
        drew = true
      }
    }
    return drew ? out : null
  }

  private entry(path: string): Entry {
    const hit = this.cache.get(path)
    if (hit) return hit
    const fresh: Entry = { state: "loading" }
    this.cache.set(path, fresh)
    void this.load(path)
    return fresh
  }

  private settle(path: string, entry: Entry): void {
    this.cache.set(path, entry)
    this.deps.requestRender()
  }

  private async load(path: string): Promise<void> {
    try {
      const { base64, mime } = path.startsWith("data:") ? fromDataUri(path) : await this.fetchMedia(path)
      this.settle(path, {
        state: "ready",
        image: new Image(base64, mime, THEME, {
          maxWidthCells: MAX_COLS,
          maxHeightCells: MAX_ROWS,
          filename: basename(path),
        }),
      })
    } catch (err: unknown) {
      this.settle(path, { state: "failed", why: err instanceof Error && err.message ? err.message : "unavailable" })
    }
  }

  /** The server serves attachments by BASENAME (`GET /api/media/:filename`), while
   *  a message stores the workspace-relative `media/<file>` — the same asymmetry
   *  the web client works around in its `<img src>`. */
  private async fetchMedia(path: string): Promise<{ base64: string; mime: string }> {
    const res = await fetch(`${this.deps.apiBase}/api/media/${encodeURIComponent(basename(path))}`)
    if (!res.ok) throw new Error(res.status === 404 ? "not on the server" : `HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const header = res.headers.get("content-type")
    return { base64: buf.toString("base64"), mime: header?.startsWith("image/") ? header : mimeOf(path) }
  }
}

function basename(path: string): string {
  return path.split("/").pop() ?? path
}

/** Extension → mime, for the case where the server did not label the response.
 *  Same four types `saveImage()` accepts. */
function mimeOf(path: string): string {
  const ext = basename(path).split(".").pop()?.toLowerCase() ?? ""
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg"
  if (ext === "webp") return "image/webp"
  if (ext === "gif") return "image/gif"
  return "image/png"
}

/** A staged attachment is still a data URI until the server rewrites it. */
export function fromDataUri(uri: string): { base64: string; mime: string } {
  const m = uri.match(/^data:(image\/[a-z+]+);base64,(.+)$/)
  if (!m) throw new Error("unsupported data URI")
  return { mime: m[1]!, base64: m[2]! }
}
