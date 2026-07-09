import type { RoomState, RoutingMode } from "@pipeline-moe/client-core"
import type { Command, CommandContext } from "./types"
import { loadImageAttachment } from "../image-attach"
import { openRosterMenu } from "../roster-menu"

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

/** Compact display form of a model ref: drop the provider prefix and .gguf. */
export function shortModel(ref: string | undefined): string | null {
  if (!ref) return null
  const tail = ref.split("/").pop() ?? ref
  return tail.replace(/\.gguf$/i, "")
}

/**
 * The agent picker of the /model loop. Reads the roster from a live snapshot
 * (not the dispatch-time ctx.state) so hints reflect swaps made moments ago;
 * each selection chains into the model picker, which returns here — one
 * /model session can realign the whole lineup. Esc exits the loop.
 */
/** Sentinel id for the trailing "+ agent" row — persona ids are slugs
 *  (lowercase, no "+"), so this can never collide with a real agent. */
const ADD_AGENT = "+agent"

function openAgentModelPicker(ctx: CommandContext): void {
  const roster = ctx.store.getSnapshot().roster
  ctx.openOverlay({
    kind: "select",
    title: "Change model for…",
    items: [
      ...roster.map((p) => ({
        id: p.id,
        label: `${p.icon} ${p.name}`,
        hint: shortModel(p.model) ?? "room default",
      })),
      { id: ADD_AGENT, label: "＋ agent", hint: "new, or clone a template" },
    ],
    emptyText: "Empty room.",
    onSelect: (id) => {
      if (id === ADD_AGENT) return void openAddAgentPicker(ctx)
      void openModelPicker(ctx, id, true)
    },
  })
}

/** The "+ agent" flow: blank form, or clone a persona template. Cloning an
 *  already-present persona auto-suffixes server-side (builder → Builder 2),
 *  so a second Builder is one keystroke. Returns to the model picker either
 *  way — this lives inside the /model loop. */
async function openAddAgentPicker(ctx: CommandContext): Promise<void> {
  try {
    const templates = await ctx.api.personaTemplates()
    ctx.openOverlay({
      kind: "select",
      title: "Add agent…",
      items: [
        { id: "", label: "＋ New agent", hint: "blank form" },
        ...templates.map((t) => ({
          id: t.id,
          label: `${t.icon} ${t.name}`,
          hint: t.model ? shortModel(t.model) ?? t.model : "room default",
        })),
      ],
      onSelect: (id) => {
        if (!id) return ctx.openOverlay({ kind: "agentForm" })
        ctx.store.actions
          .addFromTemplate(id)
          .then((item) => {
            ctx.notify(`Agent "${item.name}" added (@${item.id}).`)
            openAgentModelPicker(ctx)
          })
          // The store already surfaced the error as a notice — just resume.
          .catch(() => openAgentModelPicker(ctx))
      },
      onCancel: () => openAgentModelPicker(ctx),
    })
  } catch {
    ctx.notify("Failed to load persona templates.", "error")
  }
}

/** List available models and PATCH the chosen one onto the agent. */
async function openModelPicker(ctx: CommandContext, agentId: string, chain = false): Promise<void> {
  const agent = ctx.store.getSnapshot().roster.find((p) => p.id === agentId)
  try {
    const { models } = await ctx.api.models()
    ctx.openOverlay({
      kind: "select",
      title: `Model for ${agent?.icon ?? ""} ${agent?.name ?? agentId}`,
      items: [
        {
          id: "",
          label: `${!agent?.model ? "● " : "  "}Room default`,
          hint: "inherit the room's model",
        },
        ...models.map((m) => ({
          id: m.ref,
          label: `${m.ref === agent?.model ? "● " : "  "}${m.local ? "🖥 " : "☁ "}${m.name}`,
          hint: m.provider,
        })),
      ],
      emptyText: "No models reported by the server.",
      onSelect: (ref) => {
        ctx.store.actions
          .updateParticipant(agentId, { model: ref || null })
          .then(() => {
            ctx.notify(`@${agentId} → ${ref ? shortModel(ref) : "room default"}`)
            // Chain straight into the thinking picker: the new model may
            // support a different set of levels, and the two settings are
            // really one decision. Esc there = keep the current level.
            void openThinkingPicker(ctx, agentId, false, chain ? () => openAgentModelPicker(ctx) : undefined)
          })
          .catch(() => {
            if (chain) openAgentModelPicker(ctx)
          })
      },
      // Esc = back to the agent picker when we came from it, not out.
      onCancel: chain ? () => openAgentModelPicker(ctx) : undefined,
    })
  } catch {
    ctx.notify("Failed to load models.", "error")
  }
}

/**
 * The preset browser: pick a preset by name, then inspect its personas —
 * models, tools, flags — in a detail view before loading or applying it.
 * Esc in the detail chains back here; a preview beats blind-loading a roster.
 */
// Fallback when the server doesn't report availableThinkingLevels (older
// server or no live session yet) — mirrors src/types.ts.
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"]

function openAgentThinkingPicker(ctx: CommandContext): void {
  const roster = ctx.store.getSnapshot().roster
  ctx.openOverlay({
    kind: "select",
    title: "Thinking level for\u2026",
    items: roster.map((p) => ({
      id: p.id,
      label: `${p.icon} ${p.name}`,
      hint: p.thinkingLevel ?? "default",
    })),
    emptyText: "Empty room.",
    onSelect: (id) => void openThinkingPicker(ctx, id, true),
  })
}

async function openThinkingPicker(
  ctx: CommandContext,
  agentId: string,
  chain = false,
  /** Where to go after choosing (or Esc). Overrides the /thinking agent-picker
   *  loop — the /model flow passes its own agent picker here. */
  returnTo?: () => void,
): Promise<void> {
  const back = returnTo ?? (chain ? () => openAgentThinkingPicker(ctx) : undefined)
  try {
    // The detail endpoint knows which levels the agent's current model
    // actually supports (a local Qwen and a cloud Claude differ here).
    const detail = await ctx.store.actions.getParticipant(agentId)
    const levels = detail.availableThinkingLevels?.length ? detail.availableThinkingLevels : THINKING_LEVELS
    const current = detail.thinkingLevel
    ctx.openOverlay({
      kind: "select",
      title: `Thinking for ${detail.icon} ${detail.name}`,
      items: [
        {
          id: "",
          label: `${!current ? "\u25cf " : "  "}Default`,
          hint: "inherit the global PIPELINE_THINKING setting",
        },
        ...levels.map((l) => ({ id: l, label: `${l === current ? "\u25cf " : "  "}${l}` })),
      ],
      onSelect: (level) => {
        ctx.store.actions
          .updateParticipant(agentId, { thinkingLevel: level || null })
          .then(() => {
            ctx.notify(`@${agentId} thinking \u2192 ${level || "default"}`)
            back?.()
          })
          .catch(() => {
            back?.()
          })
      },
      // Esc = back to where we came from (agent picker / model flow), not out.
      onCancel: back,
    })
  } catch {
    ctx.notify("Failed to load agent detail.", "error")
    back?.()
  }
}

function openAgentPromptPicker(ctx: CommandContext): void {
  const roster = ctx.store.getSnapshot().roster
  ctx.openOverlay({
    kind: "select",
    title: "System prompt of\u2026",
    items: roster.map((p) => ({ id: p.id, label: `${p.icon} ${p.name}`, hint: p.id })),
    emptyText: "Empty room.",
    onSelect: (id) => ctx.openOverlay({ kind: "prompt", agentId: id }),
  })
}

async function openPresetPicker(ctx: CommandContext): Promise<void> {
  try {
    const presets = await ctx.api.presets()
    ctx.openOverlay({ kind: "presetPicker", presets })
  } catch {
    ctx.notify("Failed to load presets.", "error")
  }
}

/** Raise the masked key prompt for a provider and submit it to the store. */
function promptApiKey(ctx: CommandContext, name: string, displayName: string): void {
  ctx.openOverlay({
    kind: "textInput",
    title: `API key for ${displayName}`,
    placeholder: "paste key, ⏎ to save",
    mask: true,
    onSubmit: (key) => ctx.store.actions.addProvider(name, key),
  })
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
    summary: "Abort the current turn (or press Esc on an empty line while a turn is running)",
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
    name: "vision",
    summary: "Toggle whether an agent receives image attachments",
    usage: "@agent <on|off>",
    run: (ctx, args) => {
      const { target, rest } = splitTarget(args)
      const v = parseBool(rest)
      if (v === null) return ctx.notify("Usage: /vision @agent <on|off>", "error")
      withAgent(ctx, target, (id) => {
        ctx.store.actions.setVision(id, v)
        ctx.notify(`@${id} vision ${v ? "on" : "off — images will be omitted for this agent"}.`)
      })
    },
  },
  {
    name: "rooms",
    summary: "Switch to another room (open or closed)",
    run: async (ctx) => {
      try {
        const [open, closed] = await Promise.all([ctx.api.listRooms(), ctx.api.resumableRooms()])
        const openIds = new Set(open.map((r) => r.roomId))
        const closedOnly = closed.filter((r) => !openIds.has(r.roomId))
        const needsResume = new Set(closedOnly.map((r) => r.roomId))
        const items = [
          ...open.map((r) => ({
            id: r.roomId,
            label: `${r.roomId === ctx.store.roomId ? "● " : "  "}${r.name}`,
            hint: `${r.participantCount} agents${r.goalStatus && r.goalStatus !== "none" ? ` · ${r.goalStatus}` : ""}`,
          })),
          ...closedOnly.map((r) => ({ id: r.roomId, label: `  ${r.name}`, hint: `closed · ${r.messageCount} msg` })),
        ]
        ctx.openOverlay({
          kind: "select",
          title: "Rooms",
          items,
          emptyText: "No rooms.",
          onSelect: (id) => {
            if (id === ctx.store.roomId) return
            if (needsResume.has(id)) {
              ctx.api
                .resumeRoom(id)
                .then(() => {
                  ctx.switchRoom(id)
                  ctx.notify(`Resumed room "${id}".`)
                })
                .catch(() => ctx.notify(`Failed to resume room "${id}".`, "error"))
            } else {
              ctx.switchRoom(id)
              ctx.notify(`Switched to room "${id}".`)
            }
          },
        })
      } catch {
        ctx.notify("Failed to load rooms.", "error")
      }
    },
  },
  {
    name: "newroom",
    summary: "Create a new room and switch to it",
    usage: "[name]",
    run: (ctx, args) => {
      const name = args.trim()
      // Bare /newroom opens the full form (preset, workdir, goal) — same as
      // the tab bar's "+ room" tab.
      if (!name) return ctx.openOverlay({ kind: "roomForm" })
      ctx.api
        .createRoom({ name })
        .then((room) => {
          ctx.switchRoom(room.roomId)
          ctx.notify(`Created and switched to room "${name}".`)
        })
        .catch(() => ctx.notify(`Failed to create room "${name}".`, "error"))
    },
  },
  {
    name: "lineup",
    summary: "Edit the room line-up (reorder, pause, add, kick)",
    run: (ctx) => ctx.openOverlay({ kind: "lineup" }),
  },
  {
    name: "roster",
    summary: "Per-agent action menu (also Ctrl+R)",
    run: (ctx) => openRosterMenu(ctx),
  },
  {
    name: "tasks",
    summary: "Show the shared task board (also Ctrl+P)",
    run: (ctx) => ctx.openOverlay({ kind: "tasks" }),
  },
  {
    name: "agent",
    summary: "Create a new agent",
    run: (ctx) => ctx.openOverlay({ kind: "agentForm" }),
  },
  {
    name: "model",
    summary: "Swap an agent's model, then pick its thinking level",
    usage: "[@agent]",
    run: (ctx, args) => {
      const token = args.trim()
      if (!token) return openAgentModelPicker(ctx)
      withAgent(ctx, token, (id) => void openModelPicker(ctx, id))
    },
  },
  {
    name: "thinking",
    summary: "Set an agent's thinking level (matters for cloud models)",
    usage: "[@agent]",
    run: (ctx, args) => {
      const token = args.trim()
      if (!token) return openAgentThinkingPicker(ctx)
      withAgent(ctx, token, (id) => void openThinkingPicker(ctx, id))
    },
  },
  {
    name: "rollback",
    summary: "Remove the last message(s) from the shared transcript",
    run: (ctx) => {
      const msgs = ctx.state.messages
      if (msgs.length === 0) return ctx.notify("Transcript is empty — nothing to roll back.", "error")
      // Most recent first; picking an entry removes it AND everything after.
      const recent = [...msgs.slice(-10)].reverse()
      ctx.openOverlay({
        kind: "select",
        title: "Roll back to before… (removes that message and everything after)",
        items: recent.map((m) => {
          const n = msgs.length - m.index
          return {
            id: String(m.index),
            label: `${m.authorName}: ${m.text.replace(/\s+/g, " ").slice(0, 64)}`,
            hint: `removes ${n} msg${n === 1 ? "" : "s"}`,
          }
        }),
        onSelect: (id) => {
          // Success feedback comes from the server's own notice + the new
          // transcript over SSE — only failures need a local message.
          ctx.store.actions.rollback(Number(id)).catch((err: unknown) =>
            ctx.notify(err instanceof Error && err.message ? err.message : "Rollback failed.", "error"),
          )
        },
      })
    },
  },
  {
    name: "fork",
    summary: "Fork this discussion into a new room",
    usage: "[name]",
    run: async (ctx, args) => {
      try {
        const room = await ctx.api.forkRoom(ctx.store.roomId, args.trim() || undefined)
        ctx.notify(`Forked into "${room.name}" — switching.`)
        ctx.switchRoom(room.roomId)
      } catch (err) {
        ctx.notify(err instanceof Error && err.message ? err.message : "Fork failed.", "error")
      }
    },
  },
  {
    name: "pi-update",
    summary: "Update the server's pi runtime (fresh model catalog)",
    run: async (ctx) => {
      ctx.notify("Checking pi version…")
      try {
        const s = await ctx.api.piStatus()
        if (!s.current) return ctx.notify("Couldn't read the installed pi version on the server.", "error")
        if (s.updating) return ctx.notify("A pi update is already running.", "error")
        if (!s.latest) return ctx.notify(`pi ${s.current} installed — npm registry unreachable, can't check for updates.`, "error")
        if (!s.updateAvailable) return ctx.notify(`pi ${s.current} — already the latest.`)
        ctx.openOverlay({
          kind: "select",
          title: `Update pi ${s.current} → ${s.latest}?`,
          items: [
            { id: "update", label: "Update now", hint: "npm install on the server" },
            { id: "cancel", label: "Cancel" },
          ],
          onSelect: (id) => {
            if (id !== "update") return
            ctx.notify(`Updating pi ${s.current} → ${s.latest}… (can take a minute)`)
            ctx.api
              .piUpdate()
              .then((r) =>
                ctx.notify(`pi updated ${r.from ?? "?"} → ${r.to ?? "?"} — restart the server to load it.`),
              )
              .catch((err: unknown) =>
                ctx.notify(err instanceof Error && err.message ? err.message : "pi update failed.", "error"),
              )
          },
        })
      } catch (err) {
        ctx.notify(err instanceof Error && err.message ? err.message : "Couldn't check pi version.", "error")
      }
    },
  },
  {
    name: "prompt",
    summary: "View / edit an agent's system prompt ($EDITOR)",
    usage: "[@agent]",
    run: (ctx, args) => {
      const token = args.trim()
      if (!token) return openAgentPromptPicker(ctx)
      withAgent(ctx, token, (id) => ctx.openOverlay({ kind: "prompt", agentId: id }))
    },
  },
  {
    name: "edit",
    summary: "Edit an agent's name, icon, color, tools",
    usage: "[@agent]",
    run: (ctx, args) => {
      const token = args.trim()
      if (!token) {
        const roster = ctx.store.getSnapshot().roster
        return ctx.openOverlay({
          kind: "select",
          title: "Edit agent\u2026",
          items: roster.map((p) => ({ id: p.id, label: `${p.icon} ${p.name}`, hint: p.id })),
          emptyText: "Empty room.",
          onSelect: (id) => ctx.openOverlay({ kind: "editAgent", agentId: id }),
        })
      }
      withAgent(ctx, token, (id) => ctx.openOverlay({ kind: "editAgent", agentId: id }))
    },
  },
  {
    name: "providers",
    summary: "Manage model providers (API keys, OAuth login)",
    run: (ctx) => {
      const items = ctx.state.providers.map((p) => ({
        id: p.name,
        label: `${p.configured ? "✓" : " "} ${p.displayName}`,
        hint: p.configured
          ? "configured · ⏎ to manage"
          : p.supportsOAuth
            ? "⏎ to log in (OAuth)"
            : "⏎ to add API key",
      }))
      ctx.openOverlay({
        kind: "select",
        title: "Providers",
        items,
        emptyText: "No providers reported yet.",
        onSelect: (name) => {
          const p = ctx.state.providers.find((x) => x.name === name)
          if (!p) return
          if (p.configured) {
            ctx.openOverlay({
              kind: "select",
              title: p.displayName,
              items: [
                p.supportsOAuth
                  ? { id: "replace", label: "Log in again (OAuth)" }
                  : { id: "replace", label: "Replace API key" },
                { id: "remove", label: "Remove credentials" },
              ],
              onSelect: (action) => {
                if (action === "remove") ctx.store.actions.removeProvider(name)
                else if (p.supportsOAuth) {
                  ctx.store.actions.loginProvider(name)
                  ctx.notify(`Starting OAuth login for ${p.displayName}…`)
                } else promptApiKey(ctx, name, p.displayName)
              },
            })
          } else if (p.supportsOAuth) {
            ctx.store.actions.loginProvider(name)
            ctx.notify(`Starting OAuth login for ${p.displayName}…`)
          } else {
            promptApiKey(ctx, name, p.displayName)
          }
        },
      })
    },
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
    name: "image",
    summary: "Attach an image from a local file path",
    usage: "<path>",
    run: async (ctx, args) => {
      const path = args.trim()
      if (!path) return ctx.notify("Usage: /image <path>", "error")
      const result = await loadImageAttachment(path)
      if (!result.ok) return ctx.notify(result.error, "error")
      ctx.store.actions.send("(image shared)", [result.dataUri])
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
        await openPresetPicker(ctx)
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
