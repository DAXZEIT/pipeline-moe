import { Text } from "ink"

/** A full-width horizontal rule that closes the fixed header zone (room tabs +
 *  roster strip + task summary) off from the scrolling conversation below, so
 *  the task line reads as chrome rather than as the first message of the
 *  transcript.
 *
 *  Always rendered — a divider that toggled with task presence would resize the
 *  transcript underneath it every time the board emptied or filled. Its single
 *  row is booked unconditionally in App.tsx's `reservedRows`; if you change
 *  whether this renders, update that budget or Ink row-diffing will corrupt the
 *  layout (the vanished "── You ──" header class of bug). */
export function HeaderDivider({ width }: { width: number }) {
  return <Text dimColor>{"─".repeat(Math.max(0, width))}</Text>
}
