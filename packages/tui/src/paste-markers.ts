/**
 * Large-paste markers (pi-tui's trick, v1). The input is a single line, so a
 * multi-line paste used to be flattened into one giant space-joined string —
 * unreadable and uneditable. Instead, a paste-ish insert is stashed and the
 * input shows a compact marker (`[#1 paste +42 lines]`); markers expand back
 * to the full text at send time. A marker the user has hand-mangled no longer
 * matches the pattern and goes out literally — same rule as pi's invalid
 * paste ids.
 */

export interface PasteStore {
  seq: number
  map: Map<number, string>
}

export function newPasteStore(): PasteStore {
  return { seq: 1, map: new Map() }
}

/** Matches every intact marker; group 1 is the paste id. */
export const PASTE_MARKER_RE = /\[#(\d+) paste \+(\d+) lines\]/g

/** A chunk big enough that flattening it would wreck the input line (5+
 *  lines; a 2-4 line snippet stays inline and editable). */
export function isPastey(raw: string): boolean {
  return raw.split("\n").length >= 5
}

/** Stash the raw text and return the marker to insert in its place. */
export function stashPaste(store: PasteStore, raw: string): string {
  const id = store.seq++
  store.map.set(id, raw)
  return `[#${id} paste +${raw.split("\n").length} lines]`
}

/** Expand every intact marker whose id is still stashed; others stay literal. */
export function expandPastes(store: PasteStore, text: string): string {
  return text.replace(PASTE_MARKER_RE, (m, id) => store.map.get(Number(id)) ?? m)
}

/**
 * The span of an intact marker ending exactly at `pos` (for atomic backspace)
 * or starting exactly at `pos` (for atomic forward-delete). Null when `pos`
 * doesn't touch a marker boundary — plain character editing applies, which
 * breaks the marker and demotes it to literal text (accepted v1 behavior).
 */
export function markerSpanAt(
  text: string,
  pos: number,
  edge: "ending" | "starting",
): { start: number; end: number; id: number } | null {
  PASTE_MARKER_RE.lastIndex = 0
  for (const m of text.matchAll(PASTE_MARKER_RE)) {
    const start = m.index
    const end = start + m[0].length
    if (edge === "ending" ? end === pos : start === pos) {
      return { start, end, id: Number(m[1]) }
    }
  }
  return null
}
