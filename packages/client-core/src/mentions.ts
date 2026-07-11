// Routing preview for USER messages — the client-side mirror of the server's
// Room.resolveTargets (src/room.ts: MENTION_RE + resolution rules).
//
// Why this exists: user-message routing scans the WHOLE text for @mentions,
// so pasting a transcript or report that quotes agent handles routes those
// agents (observed live 2026-07-11, session mrff3qwe: a pasted report
// containing "✗ @builder → @tester refused" queued both). The server-side
// twin of that bug (F5, agents quoting handoffs) was fixed by the enum
// handoff tool; on the human side we fix it with OBSERVABILITY: the composer
// shows where a draft will route BEFORE it is sent.
//
// Keep in lockstep with the server: same regex (/@(\w+)/g, lowercased), @all
// fan-out to every active agent, mention insertion order, unknown/inactive
// mentions skipped (surfaced here as `dropped` so a dud mention is visible).

import type { RosterItem } from "./types.js"

export interface RoutingPreview {
  /** "mentions": explicit @ids; "all": @all fan-out; "default": no mention →
   *  defaultAgent (or first active); "none": nothing would run. */
  kind: "mentions" | "all" | "default" | "none"
  targetIds: string[]
  /** Mentioned ids that will NOT run (unknown or inactive) — a quoted or
   *  misspelled mention the sender should see before sending. */
  dropped: string[]
}

export function previewRouting(
  text: string,
  roster: Array<Pick<RosterItem, "id" | "active">>,
  defaultAgent: string | null | undefined,
): RoutingPreview {
  const mentioned = new Set<string>()
  const re = /@(\w+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) mentioned.add(m[1].toLowerCase())

  const active = roster.filter((r) => r.active)

  if (mentioned.has("all")) {
    return { kind: "all", targetIds: active.map((r) => r.id), dropped: [] }
  }

  if (mentioned.size === 0) {
    if (active.length === 0) return { kind: "none", targetIds: [], dropped: [] }
    const preferred = defaultAgent ? active.find((r) => r.id === defaultAgent) : undefined
    return { kind: "default", targetIds: [(preferred ?? active[0]).id], dropped: [] }
  }

  const targetIds: string[] = []
  const dropped: string[] = []
  for (const id of mentioned) {
    const p = roster.find((r) => r.id === id)
    if (p && p.active) targetIds.push(id)
    else dropped.push(id)
  }
  return { kind: "mentions", targetIds, dropped }
}
