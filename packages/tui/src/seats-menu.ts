import type { RosterItem } from "@pipeline-moe/client-core"
import type { CommandContext, SelectItem } from "./commands/types"
// Circular with registry.ts (it registers /seats → openSeatsMenu): safe —
// both sides only call the other's hoisted functions at runtime, never at
// module-evaluation time. Same pattern as roster-menu.ts.
import { shortModel } from "./commands/registry"

/**
 * The /seats menu — fused-seats configuration à la Ctrl+R roster menu
 * (docs/fused-seats.md): two chained SelectOverlays. Level 1 shows the seat
 * map (fused clusters first, then own-context members); level 2 offers the
 * chosen agent's seat moves — join an existing fused seat, share a NEW seat
 * with another member (named via a text prompt), or detach.
 *
 * Every action dispatches the corresponding server-side /seats text command
 * through store.actions.send — the room owns the seat lifecycle (living-seat
 * join, no-adoption fresh seats, orphaned dirs, modelRef invariant) and its
 * notice comes back over SSE. This module adds navigation, not new behavior.
 */

/** Same declared-model comparison the server's invariant uses: undefined on
 *  both sides = both on the host default = compatible. */
function modelsDiffer(a: RosterItem, b: RosterItem): boolean {
  return (a.model ?? null) !== (b.model ?? null)
}

const MISMATCH_HINT = "⚠ different model — the server will refuse"

/** Level 1 rows: fused clusters first (hats adjacent, ⌐seat prefix), then
 *  own-context members. Pure — grouping, order and labels are what tests pin. */
export function seatPickerItems(roster: RosterItem[]): SelectItem[] {
  const fused = new Map<string, RosterItem[]>()
  const singles: RosterItem[] = []
  for (const p of roster) {
    if (p.seat) fused.set(p.seat, [...(fused.get(p.seat) ?? []), p])
    else singles.push(p)
  }
  const items: SelectItem[] = []
  for (const [seat, hats] of fused) {
    for (const p of hats) {
      const mates = hats.filter((o) => o.id !== p.id).map((o) => `@${o.id}`)
      const model = shortModel(p.model)
      items.push({
        id: p.id,
        label: `⌐${seat} · ${p.icon} ${p.name}`,
        hint: `shares context with ${mates.join(", ")}${model ? ` · ${model}` : ""}`,
      })
    }
  }
  for (const p of singles) {
    const model = shortModel(p.model)
    items.push({
      id: p.id,
      label: `${p.icon} ${p.name}`,
      hint: `own context${model ? ` · ${model}` : ""}`,
    })
  }
  return items
}

/** Level 2 rows for one agent: join each OTHER fused seat, share a new seat
 *  with each own-context member, detach when fused. Model mismatches are
 *  flagged in the hint but not hidden — the server refuses loudly and the
 *  hint explains the fix before the user hits it. */
export function seatActionItems(agent: RosterItem, roster: RosterItem[]): SelectItem[] {
  const items: SelectItem[] = []
  const fused = new Map<string, RosterItem[]>()
  for (const p of roster) {
    if (p.seat && p.id !== agent.id) fused.set(p.seat, [...(fused.get(p.seat) ?? []), p])
  }
  for (const [seat, hats] of fused) {
    if (seat === agent.seat) continue
    const mismatch = hats.some((h) => modelsDiffer(agent, h))
    items.push({
      id: `join:${seat}`,
      label: `⇥ Join ⌐${seat}`,
      hint: `${hats.map((h) => `@${h.id}`).join(" + ")}${mismatch ? ` · ${MISMATCH_HINT}` : ""}`,
    })
  }
  for (const p of roster) {
    if (p.id === agent.id || p.seat) continue
    const mismatch = modelsDiffer(agent, p)
    items.push({
      id: `pair:${p.id}`,
      label: `⧉ Share a seat with ${p.icon} ${p.name}…`,
      hint: `you name the seat${mismatch ? ` · ${MISMATCH_HINT}` : ""}`,
    })
  }
  if (agent.seat) {
    items.push({
      id: "solo",
      label: "⏏ Detach to own context",
      hint: "fresh session — the shared one stays with the seat",
    })
  }
  return items
}

/** Open the seat map (level 1). */
export function openSeatsMenu(ctx: CommandContext): void {
  const state = ctx.store.getSnapshot()
  ctx.openOverlay({
    kind: "select",
    title: "Seats — shared contexts (pick an agent)",
    items: seatPickerItems(state.roster),
    emptyText: "Empty room.",
    onSelect: (id) => openSeatActions(ctx, id),
  })
}

/** Open one agent's seat moves (level 2). Esc returns to the map. */
export function openSeatActions(ctx: CommandContext, agentId: string): void {
  const state = ctx.store.getSnapshot()
  const agent = state.roster.find((p) => p.id === agentId)
  if (!agent) return ctx.notify(`No agent "${agentId}" in the room.`, "error")
  const items = seatActionItems(agent, state.roster)
  if (items.length === 0) {
    return ctx.notify(`@${agentId} has nobody to share a seat with — add another agent first.`, "info")
  }
  ctx.openOverlay({
    kind: "select",
    title: `${agent.icon} ${agent.name} — ${agent.seat ? `⌐${agent.seat} seat` : "own context"}`,
    items,
    onSelect: (action) => runSeatAction(ctx, agent, action),
    onCancel: () => openSeatsMenu(ctx),
  })
}

/** Seat names travel through the same slug discipline as the server's ids. */
function slugSeat(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function runSeatAction(ctx: CommandContext, agent: RosterItem, action: string): void {
  if (action === "solo") {
    ctx.store.actions.send(`/seats solo @${agent.id}`)
    return
  }
  if (action.startsWith("join:")) {
    ctx.store.actions.send(`/seats fuse ${action.slice("join:".length)} @${agent.id}`)
    return
  }
  if (action.startsWith("pair:")) {
    const other = action.slice("pair:".length)
    ctx.openOverlay({
      kind: "textInput",
      title: `Name the seat @${agent.id} + @${other} will share`,
      placeholder: "maker",
      onSubmit: (text) => {
        const seat = slugSeat(text)
        if (!seat) return ctx.notify("Seat name must contain at least one of [a-z0-9].", "error")
        ctx.store.actions.send(`/seats fuse ${seat} @${agent.id} @${other}`)
      },
    })
  }
}
