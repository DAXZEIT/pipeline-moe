// Pure formatting helpers for the Transcript's flattened line model — split
// out (same pattern as escape-behavior.ts) so the parts with real logic are
// unit-testable without rendering Ink.

import type { Receipt } from "@pipeline-moe/client-core"

/** One display line of the transcript — mirrors Transcript.tsx's Line shape
 *  (minus the cursor flag, which only live headers use). */
export interface FormattedLine {
  text: string
  color?: string
  bold?: boolean
  dim?: boolean
}

/** The message header as a full-width rule in the author's color —
 *  `── 🧪 Tester ─────────…` — instead of a bare name. The WebUI separates
 *  replies with card borders; this is the terminal equivalent, and it costs
 *  no extra row since it replaces the name line. Padding is best-effort on
 *  emoji width (an icon may render 2 cols for 2 JS chars); the Transcript
 *  renders with wrap="truncate-end", which absorbs any 1-col overshoot. */
export function headerRule(name: string, icon: string | undefined, width: number): string {
  const prefix = `── ${icon ? `${icon} ` : ""}${name} `
  return prefix + "─".repeat(Math.max(0, width - prefix.length))
}

/** The TUI counterpart of the WebUI's WORK RECEIPT block: a dim header plus
 *  one line per filesystem-verified change, colored by kind (+ green created,
 *  ~ yellow modified, − red deleted). Empty receipts render nothing — same
 *  contract as the web's ReceiptView. */
export function receiptLines(r: Receipt): FormattedLine[] {
  const chips = [
    ...r.created.map((p) => ({ p, kind: "+", color: "green" })),
    ...r.modified.map((p) => ({ p, kind: "~", color: "yellow" })),
    ...r.deleted.map((p) => ({ p, kind: "−", color: "red" })),
  ]
  if (chips.length === 0) return []
  return [
    { text: "📦 work receipt — filesystem-verified", dim: true },
    ...chips.map(({ p, kind, color }) => ({ text: `  ${kind} ${p}`, color })),
  ]
}
