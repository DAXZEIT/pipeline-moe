import type { RosterItem } from "@pipeline-moe/client-core"
import type { CommandContext, SelectItem } from "./commands/types"
// Circular with registry.ts (it registers /roster → openRosterMenu): safe —
// both sides only call the other's hoisted functions at runtime, never at
// module-evaluation time.
import { lookup, shortModel } from "./commands/registry"

/**
 * The Ctrl+R roster menu — the TUI counterpart of the WebUI's per-agent "…"
 * dropdown, built from two chained SelectOverlays: an agent picker (filter by
 * typing, live status hints), then a contextual action menu for the chosen
 * agent. Esc in the action menu returns to the picker (SelectOverlay's
 * onCancel exists for exactly this submenu → parent pattern); the one
 * destructive action (kick) takes a confirm step.
 *
 * Every action dispatches through the same store actions / overlays the slash
 * commands use — this module adds navigation, not new behavior. Labels are
 * generated from live roster state so toggles read as state ("Parallel: on"),
 * not blind verbs.
 */

/** One row of the agent picker: identity + live status at a glance. */
export function rosterPickerItems(roster: RosterItem[], defaultAgent: string | null): SelectItem[] {
  return roster.map((p) => {
    const ctx = p.contextUsage?.tokens != null
      ? ` · ${Math.round(p.contextUsage.tokens / 1000)}K`
      : ""
    const star = p.id === defaultAgent ? " ⭐" : ""
    const off = p.active ? "" : " · inactive"
    return {
      id: p.id,
      label: `${p.icon} ${p.name}${star}`,
      hint: `${p.status}${ctx}${off}${shortModel(p.model) ? ` · ${shortModel(p.model)}` : ""}`,
    }
  })
}

/** The contextual action list for one agent. Pure — the composition (which
 *  actions appear, and their state-bearing labels) is what tests pin down. */
export function agentActionItems(agent: RosterItem, isDefault: boolean): SelectItem[] {
  const items: SelectItem[] = [
    { id: "edit", label: "✏️  Edit persona", hint: "name, icon, color, tools" },
    { id: "prompt", label: "💬 View prompt", hint: "$EDITOR" },
    { id: "model", label: "🧠 Model & thinking", hint: shortModel(agent.model) ?? "default" },
    { id: "default", label: `⭐ Default agent: ${isDefault ? "on" : "off"}`, hint: isDefault ? "unset" : "receives unaddressed messages" },
    { id: "parallel", label: `⫽  Parallel: ${agent.parallel ? "on" : "off"}`, hint: "toggle" },
    { id: "vision", label: `👁  Vision: ${agent.vision === false ? "off" : "on"}`, hint: "toggle image input" },
    { id: "active", label: agent.active ? "💤 Deactivate" : "▶  Activate", hint: agent.active ? "sit out turns" : "rejoin the room" },
    { id: "compact", label: "🗜  Compact context", hint: "summarize history" },
  ]
  // Steering only means something mid-turn.
  if (agent.status === "working" || agent.status === "thinking" || agent.status === "active") {
    items.splice(2, 0, { id: "steer", label: "🎯 Steer this turn…", hint: "inject guidance now" })
  }
  items.push({ id: "kick", label: "🗑  Kick from room", hint: "confirm" })
  return items
}

/** Open the agent picker (level 1). */
export function openRosterMenu(ctx: CommandContext): void {
  const state = ctx.store.getSnapshot()
  ctx.openOverlay({
    kind: "select",
    title: "Roster — pick an agent",
    items: rosterPickerItems(state.roster, state.defaultAgent),
    emptyText: "Empty room.",
    onSelect: (id) => openAgentActions(ctx, id),
  })
}

/** Open one agent's action menu (level 2). Esc returns to the picker. */
export function openAgentActions(ctx: CommandContext, agentId: string): void {
  const state = ctx.store.getSnapshot()
  const agent = state.roster.find((p) => p.id === agentId)
  if (!agent) return ctx.notify(`No agent "${agentId}" in the room.`, "error")
  const isDefault = state.defaultAgent === agentId
  const ctxUse = agent.contextUsage?.tokens != null
    ? ` · ${Math.round(agent.contextUsage.tokens / 1000)}K/${Math.round(agent.contextUsage.contextWindow / 1000)}K`
    : ""

  ctx.openOverlay({
    kind: "select",
    title: `${agent.icon} ${agent.name} · ${agent.status}${ctxUse}`,
    items: agentActionItems(agent, isDefault),
    onSelect: (action) => runAgentAction(ctx, agent, isDefault, action),
    onCancel: () => openRosterMenu(ctx),
  })
}

function runAgentAction(ctx: CommandContext, agent: RosterItem, isDefault: boolean, action: string): void {
  const id = agent.id
  switch (action) {
    case "edit":
      return ctx.openOverlay({ kind: "editAgent", agentId: id })
    case "prompt":
      return ctx.openOverlay({ kind: "prompt", agentId: id })
    case "model":
      // The /model command owns the model→thinking picker chain.
      return void lookup("model")?.run(ctx, `@${id}`)
    case "steer":
      return ctx.openOverlay({
        kind: "textInput",
        title: `Steer @${id} — guidance lands mid-turn`,
        placeholder: "e.g. stop exploring, commit what you have",
        onSubmit: (text) => {
          if (!text.trim()) return
          ctx.store.actions.steer(text.trim(), id)
          ctx.notify(`Steered @${id}.`)
        },
      })
    case "default":
      ctx.store.actions.setDefaultAgent(isDefault ? null : id)
      ctx.notify(isDefault ? "Default agent cleared." : `@${id} is now the default agent.`)
      return
    case "parallel":
      ctx.store.actions.setParallel(id, !agent.parallel)
      ctx.notify(`@${id} parallel ${agent.parallel ? "off" : "on"}.`)
      return
    case "vision":
      ctx.store.actions.setVision(id, agent.vision === false)
      ctx.notify(`@${id} vision ${agent.vision === false ? "on" : "off"}.`)
      return
    case "active":
      ctx.store.actions.setActive(id, !agent.active)
      ctx.notify(`@${id} ${agent.active ? "paused" : "active"}.`)
      return
    case "compact":
      ctx.store.actions.compactAgent(id)
      ctx.notify(`Compacting @${id}…`)
      return
    case "kick":
      // The only destructive action in the menu — confirm first. Esc returns
      // to the agent's own menu, not all the way out.
      return ctx.openOverlay({
        kind: "select",
        title: `Kick ${agent.icon} ${agent.name} from the room?`,
        items: [
          { id: "no", label: "Cancel", hint: "keep the agent" },
          { id: "yes", label: `🗑  Yes, kick @${id}`, hint: "removes it from the roster" },
        ],
        onSelect: (choice) => {
          if (choice === "yes") {
            ctx.store.actions.kick(id)
            ctx.notify(`Kicked @${id}.`)
          } else {
            openAgentActions(ctx, id)
          }
        },
        onCancel: () => openAgentActions(ctx, id),
      })
  }
}
