import type { RoomState, RoutingMode } from "@pipeline-moe/client-core"
import type { Command, CommandContext } from "./types"

/** Resolve a "@name" / "name" / id token to a roster participant id, or null. */
export function resolveAgent(state: RoomState, token: string): string | null {
  const t = token.replace(/^@/, "").trim().toLowerCase()
  if (!t) return null
  const byId = state.roster.find((p) => p.id.toLowerCase() === t)
  if (byId) return byId.id
  const byName = state.roster.find((p) => p.name.toLowerCase() === t)
  return byName ? byName.id : null
}

/** Parse on/off/true/false/1/0 into a boolean, or null if unrecognised. */
function parseBool(token: string): boolean | null {
  const t = token.trim().toLowerCase()
  if (["on", "true", "yes", "1"].includes(t)) return true
  if (["off", "false", "no", "0"].includes(t)) return false
  return null
}

/** Split "@scribe slow down" into { target: "@scribe", rest: "slow down" }. */
function splitTarget(args: string): { target: string; rest: string } {
  const trimmed = args.trim()
  const sp = trimmed.indexOf(" ")
  if (sp === -1) return { target: trimmed, rest: "" }
  return { target: trimmed.slice(0, sp), rest: trimmed.slice(sp + 1).trim() }
}

// A small helper that resolves an agent token and notifies on failure.
function withAgent(ctx: CommandContext, token: string, fn: (id: string) => void): void {
  const id = resolveAgent(ctx.state, token)
  if (!id) {
    ctx.notify(`No agent matches "${token || "(empty)"}". Try @<name>.`, "error")
    return
  }
  fn(id)
}

export const COMMANDS: Command[] = [
  {
    name: "help",
    summary: "List all commands",
    run: (ctx) => {
      ctx.openOverlay({
        kind: "select",
        title: "Commands",
        items: COMMANDS.map((c) => ({
          id: c.name,
          label: `/${c.name}${c.usage ? " " + c.usage : ""}`,
          hint: c.summary,
        })),
        onSelect: () => ctx.closeOverlay(),
      })
    },
  },
  {
    name: "resume",
    summary: "Switch to another conversation",
    run: (ctx) => {
      const items = ctx.state.conversations.map((c) => ({
        id: c.id,
        label: c.id === ctx.state.currentConversationId ? `● ${c.title}` : `  ${c.title}`,
        hint: `${c.messageCount} msg`,
      }))
      ctx.openOverlay({
        kind: "select",
        title: "Resume conversation",
        items,
        emptyText: "No saved conversations yet.",
        onSelect: (id) => {
          ctx.store.actions.loadConversation(id)
          ctx.notify(`Switched conversation.`)
        },
      })
    },
  },
  {
    name: "new",
    summary: "Start a new conversation",
    usage: "[title]",
    run: (ctx, args) => {
      const title = args.trim() || undefined
      ctx.store.actions.newConversation(title)
      ctx.notify(`New conversation${title ? ` "${title}"` : ""} created.`)
    },
  },
  {
    name: "rename",
    summary: "Rename the current conversation",
    usage: "<title>",
    run: (ctx, args) => {
      const title = args.trim()
      if (!title) return ctx.notify("Usage: /rename <title>", "error")
      ctx.store.actions.renameConversation(ctx.state.currentConversationId, title)
      ctx.notify(`Conversation renamed to "${title}".`)
    },
  },
  {
    name: "route",
    summary: "Set the handoff routing mode",
    usage: "<auto|semi|manual>",
    run: (ctx, args) => {
      const mode = args.trim().toLowerCase() as RoutingMode
      if (!["auto", "semi", "manual"].includes(mode)) {
        return ctx.notify("Usage: /route <auto|semi|manual>", "error")
      }
      ctx.store.actions.setRoutingMode(mode)
      ctx.notify(`Routing mode → ${mode}.`)
    },
  },
  {
    name: "chain",
    summary: "Toggle agent→agent chaining",
    usage: "<on|off>",
    run: (ctx, args) => {
      const v = parseBool(args)
      if (v === null) return ctx.notify("Usage: /chain <on|off>", "error")
      ctx.store.actions.setChaining(v)
      ctx.notify(`Chaining ${v ? "enabled" : "disabled"}.`)
    },
  },
  {
    name: "steer",
    summary: "Steer a running agent mid-turn",
    usage: "@agent <text>",
    run: (ctx, args) => {
      const { target, rest } = splitTarget(args)
      if (!rest) return ctx.notify("Usage: /steer @agent <text>", "error")
      withAgent(ctx, target, (id) => {
        ctx.store.actions.steer(rest, id)
        ctx.notify(`Steered @${id}.`)
      })
    },
  },
  {
    name: "abort",
    summary: "Abort the current turn",
    run: (ctx) => {
      ctx.store.actions.abort()
      ctx.notify("Turn aborted.")
    },
  },
  {
    name: "compact",
    summary: "Compact an agent's context",
    usage: "@agent",
    run: (ctx, args) => withAgent(ctx, args, (id) => ctx.store.actions.compactAgent(id)),
  },
  {
    name: "kick",
    summary: "Remove an agent from the room",
    usage: "@agent",
    run: (ctx, args) =>
      withAgent(ctx, args, (id) => {
        ctx.store.actions.kick(id)
        ctx.notify(`Kicked @${id}.`)
      }),
  },
  {
    name: "active",
    summary: "Pause or resume an agent",
    usage: "@agent <on|off>",
    run: (ctx, args) => {
      const { target, rest } = splitTarget(args)
      const v = parseBool(rest)
      if (v === null) return ctx.notify("Usage: /active @agent <on|off>", "error")
      withAgent(ctx, target, (id) => {
        ctx.store.actions.setActive(id, v)
        ctx.notify(`@${id} ${v ? "active" : "paused"}.`)
      })
    },
  },
  {
    name: "parallel",
    summary: "Toggle an agent's parallel flag",
    usage: "@agent <on|off>",
    run: (ctx, args) => {
      const { target, rest } = splitTarget(args)
      const v = parseBool(rest)
      if (v === null) return ctx.notify("Usage: /parallel @agent <on|off>", "error")
      withAgent(ctx, target, (id) => {
        ctx.store.actions.setParallel(id, v)
        ctx.notify(`@${id} parallel ${v ? "on" : "off"}.`)
      })
    },
  },
  {
    name: "lineup",
    summary: "Edit the room line-up (reorder, pause, add, kick)",
    run: (ctx) => ctx.openOverlay({ kind: "lineup" }),
  },
  {
    name: "agent",
    summary: "Create a new agent",
    run: (ctx) => ctx.openOverlay({ kind: "agentForm" }),
  },
  {
    name: "template",
    summary: "Add an agent from a built-in template",
    run: async (ctx) => {
      try {
        const templates = await ctx.api.personaTemplates()
        ctx.openOverlay({
          kind: "select",
          title: "Add from template",
          items: templates.map((t) => ({ id: t.id, label: `${t.icon} ${t.name}`, hint: t.model ?? "default model" })),
          emptyText: "No templates available.",
          onSelect: (id) => {
            ctx.store.actions.addFromTemplate(id).then(() => ctx.notify(`Added @${id} from template.`)).catch(() => {})
          },
        })
      } catch {
        ctx.notify("Failed to load templates.", "error")
      }
    },
  },
  {
    name: "preset",
    summary: "Save or load a room preset",
    usage: "save <name> | load",
    run: async (ctx, args) => {
      const { target: sub, rest } = splitTarget(args)
      if (sub === "save") {
        const name = rest.trim()
        if (!name) return ctx.notify("Usage: /preset save <name>", "error")
        ctx.store.actions.savePreset(name).then(() => ctx.notify(`Preset "${name}" saved.`)).catch(() => {})
        return
      }
      if (sub === "load" || sub === "") {
        try {
          const presets = await ctx.api.presets()
          ctx.openOverlay({
            kind: "select",
            title: "Load preset (replaces line-up)",
            items: presets.map((p) => ({ id: p.name, label: p.name, hint: `${p.personas.length} agents` })),
            emptyText: "No saved presets.",
            onSelect: (name) => {
              ctx.store.actions.loadPreset(name).then(() => ctx.notify(`Loaded preset "${name}".`)).catch(() => {})
            },
          })
        } catch {
          ctx.notify("Failed to load presets.", "error")
        }
        return
      }
      ctx.notify("Usage: /preset save <name> | /preset load", "error")
    },
  },
]

/** Resolve a typed command head to a single command (exact, else unique prefix). */
export function lookup(head: string): Command | null {
  const h = head.toLowerCase()
  const exact = COMMANDS.find((c) => c.name === h)
  if (exact) return exact
  const matches = COMMANDS.filter((c) => c.name.startsWith(h))
  return matches.length === 1 ? matches[0] : null
}

/** Commands whose name matches the current partial head, for the palette. */
export function matchCommands(head: string): Command[] {
  const h = head.toLowerCase()
  if (!h) return COMMANDS
  return COMMANDS.filter((c) => c.name.startsWith(h))
}
