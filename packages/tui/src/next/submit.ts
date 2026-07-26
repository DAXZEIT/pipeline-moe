// What ⏎ means, as a pure function of the draft.
//
// This is the decision half of CommandLine's Enter handler, lifted out of the
// component so it can be tested without a terminal: three sigils ("/" command,
// "!" shell, anything else a room message) plus the two empty cases, which are
// NOT the same thing — an empty draft is a gesture the app can use (the "+ room"
// tab reads it), while a lone "!" is a mode with nothing in it and must simply
// clear.
//
// The text handed in must already be EXPANDED (`editor.getExpandedText()`), so a
// pasted block's real content is what gets classified and sent. That is the
// paste-dispatch guard's other half: the routing preview and the send agree on
// exactly one string.

import type { RoutingMode } from "@pipeline-moe/client-core"

export type Submission =
  /** Nothing typed — the caller may treat it as a gesture. */
  | { kind: "empty" }
  /** Typed, but there is nothing to do (a bare "!"). Clear and move on. */
  | { kind: "noop" }
  | { kind: "command"; input: string }
  | { kind: "shell"; command: string }
  | { kind: "send"; text: string }

export function classifySubmit(expanded: string, pendingImages = 0): Submission {
  const text = expanded.trim()
  // A staged image can go out with no text at all (image-only message, mirroring
  // the web Composer), so an empty draft with an image is a send.
  if (!text) return pendingImages > 0 ? { kind: "send", text: "" } : { kind: "empty" }
  if (text.startsWith("/")) return { kind: "command", input: text }
  if (text.startsWith("!")) {
    const command = text.slice(1).trim()
    return command ? { kind: "shell", command } : { kind: "noop" }
  }
  return { kind: "send", text }
}

/** ⇧⇥ cycles routing without typing /route. Order is the escalation order: the
 *  room decides → you approve → nothing moves unmentioned → an agent decides. */
export const ROUTING_ORDER: RoutingMode[] = ["auto", "semi", "manual", "supervised"]

export function nextRoutingMode(current: RoutingMode): RoutingMode {
  const i = ROUTING_ORDER.indexOf(current)
  return ROUTING_ORDER[(i + 1) % ROUTING_ORDER.length]!
}
