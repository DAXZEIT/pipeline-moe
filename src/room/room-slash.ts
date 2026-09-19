import { config } from "../config.js"
import { RoomConversations } from "./room-conversations.js"

export abstract class RoomSlash extends RoomConversations {
  /** Handle slash commands. Returns true if handled. */
  protected async handleSlashCommand(text: string): Promise<boolean> {
    if (!text.startsWith("/")) return false
    const [cmd, ...args] = text.split(/\s+/)
    const rawTarget = args[0]
    const id = rawTarget?.replace(/^@/, "").toLowerCase()

    switch (cmd) {
      case "/kick":
        if (id && this.registry.has(id)) {
          // Async (refcounted seat rebuild) — the notice follows the actual
          // removal; a failure surfaces as an error notice, never silence.
          // Promise.resolve: test doubles implement kick synchronously.
          void Promise.resolve(this.registry.kick(id))
            .then(() => this.notice(`Kicked @${id}.`))
            .catch((err) =>
              this.notice(
                `/kick @${id} failed: ${err instanceof Error ? err.message : String(err)}`,
                "error",
              ),
            )
        } else
          this.notice(
            `/kick: unknown participant "${rawTarget ?? ""}".`,
            "error",
          )
        return true
      case "/deactivate":
        if (id && this.registry.has(id)) {
          this.registry.setActive(id, false)
          this.notice(`Deactivated @${id}.`)
        } else
          this.notice(
            `/deactivate: unknown participant "${rawTarget ?? ""}".`,
            "error",
          )
        return true
      case "/activate":
        if (id && this.registry.has(id)) {
          this.registry.setActive(id, true)
          this.notice(`Activated @${id}.`)
        } else
          this.notice(
            `/activate: unknown participant "${rawTarget ?? ""}".`,
            "error",
          )
        return true
      case "/seats": {
        // Fused seats (docs/fused-seats.md): live-room seat management.
        //   /seats                     → show the seat map
        //   /seats fuse <seat> @a @b…  → these hats share the <seat> context
        //   /seats solo @a…            → detach hat(s) back to singleton
        const sub = args[0]?.toLowerCase()
        if (!sub) {
          const items = this.registry.roster()
          const fused = new Map<string, string[]>()
          const singles: string[] = []
          for (const it of items) {
            if (it.seat)
              fused.set(it.seat, [...(fused.get(it.seat) ?? []), it.id])
            else singles.push(it.id)
          }
          const parts = [...fused.entries()].map(
            ([s, hats]) => `⌐${s}: ${hats.map((h) => `@${h}`).join(" + ")}`,
          )
          this.notice(
            `Seats: ${parts.length > 0 ? parts.join(" · ") : "none fused"}` +
              (singles.length > 0
                ? ` · singletons: ${singles.map((s) => `@${s}`).join(", ")}`
                : "") +
              `\nUsage: /seats fuse <seat> @a @b… · /seats solo @a…`,
          )
          return true
        }
        if (this.isGenerating()) {
          this.notice(
            `/seats: agents are generating — wait or press Stop first (reseating rebuilds sessions).`,
            "error",
          )
          return true
        }
        const mentions = args
          .slice(sub === "fuse" ? 2 : 1)
          .map((a) => a.replace(/^@/, "").toLowerCase())
          .filter(Boolean)
        const unknown = mentions.find((m) => !this.registry.has(m))
        if (unknown) {
          this.notice(`/seats: unknown participant "@${unknown}".`, "error")
          return true
        }
        if (sub === "fuse") {
          const seatName = args[1]?.replace(/^@/, "").toLowerCase()
          if (!seatName || mentions.length < 1) {
            this.notice(
              `/seats fuse: usage — /seats fuse <seat> @a @b…`,
              "error",
            )
            return true
          }
          void this.registry
            .reseat(mentions, seatName)
            .then((summary) => this.notice(summary))
            .catch((err) =>
              this.notice(
                `/seats fuse failed: ${err instanceof Error ? err.message : String(err)}`,
                "error",
              ),
            )
          return true
        }
        if (sub === "solo") {
          if (mentions.length < 1) {
            this.notice(`/seats solo: usage — /seats solo @a…`, "error")
            return true
          }
          void (async () => {
            for (const m of mentions) {
              const summary = await this.registry.reseat([m], m)
              this.notice(summary)
            }
          })().catch((err) =>
            this.notice(
              `/seats solo failed: ${err instanceof Error ? err.message : String(err)}`,
              "error",
            ),
          )
          return true
        }
        this.notice(
          `/seats: unknown subcommand "${sub}" — use fuse, solo, or no argument for the map.`,
          "error",
        )
        return true
      }
      case "/compact": {
        if (!id) {
          this.notice(`/compact: usage — /compact @agent`, "error")
          return true
        }
        // Route through the shared op so this path and the REST endpoints share
        // ONE compact-then-broadcast contract (see compactParticipant).
        const outcome = await this.compactParticipant(id, () =>
          this.notice(`Compacting @${id}'s context…`),
        )
        if (outcome.ok) {
          this.notice(
            `@${id} compacted: ${outcome.result.tokensBefore} tokens before → summary generated.`,
          )
        } else if (outcome.reason === "unknown") {
          this.notice(
            `/compact: unknown participant "${rawTarget ?? ""}".`,
            "error",
          )
        } else if (outcome.reason === "generating") {
          this.notice(
            `/compact: agents are generating — wait or press Stop first.`,
            "error",
          )
        } else {
          this.notice(`/compact @${id} failed: ${outcome.message}`, "error")
        }
        return true
      }
      case "/help":
        this.notice(
          "Commands: /help, /kick @agent, /activate @agent, /deactivate @agent, " +
            "/compact @agent, /model @agent provider/id (alias: /add), /thinking [level|@agent level], " +
            "/stats [@agent], /chaining on|off, /default @agent|none, /fallback @agent|none, " +
            "/provider [list|add <name> <key>|remove <name>]",
        )
        return true
      case "/model":
      case "/add": {
        const agentId = args[0]?.replace(/^@/, "").toLowerCase()
        const modelRef = args[1]
        if (!agentId || !modelRef) {
          this.notice(`${cmd}: usage — ${cmd} @agent provider/id`, "error")
          return true
        }
        if (!this.registry.has(agentId)) {
          this.notice(`${cmd}: unknown participant "@${agentId}".`, "error")
          return true
        }
        if (!this.registry.isAllowedModel(modelRef)) {
          this.notice(
            `${cmd}: "${modelRef}" is not available. Use GET /api/models to list.`,
            "error",
          )
          return true
        }
        try {
          await this.registry.update(agentId, { model: modelRef })
          this.notice(`@${agentId} model → ${modelRef}`)
        } catch (err) {
          this.notice(
            `${cmd} @${agentId} failed: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          )
        }
        return true
      }
      case "/thinking": {
        const LEVELS = [
          "off",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
        ] as const
        if (args[0]?.startsWith("@")) {
          // Per-agent: /thinking @agent level
          const agentId = args[0].replace(/^@/, "").toLowerCase()
          const level = args[1]
          if (!level || !(LEVELS as readonly string[]).includes(level)) {
            this.notice(
              `/thinking: usage — /thinking @agent ${LEVELS.join("|")}`,
              "error",
            )
            return true
          }
          const p = this.registry.get(agentId)
          if (!p) {
            this.notice(
              `/thinking: unknown participant "@${agentId}".`,
              "error",
            )
            return true
          }
          const available = p.getAvailableThinkingLevels?.()
          if (available && available.length > 0 && !available.includes(level)) {
            this.notice(
              `/thinking: "${level}" not available for @${agentId}. Available: ${available.join(", ")}`,
              "error",
            )
            return true
          }
          try {
            await this.registry.setThinkingLevel(
              agentId,
              level as (typeof LEVELS)[number],
            )
            this.notice(`@${agentId} thinking → ${level}`)
          } catch (err) {
            this.notice(
              `/thinking @${agentId} failed: ${err instanceof Error ? err.message : String(err)}`,
              "error",
            )
          }
        } else {
          // Global: /thinking level
          const level = args[0]
          if (!level || !(LEVELS as readonly string[]).includes(level)) {
            this.notice(
              `/thinking: usage — /thinking ${LEVELS.join("|")}`,
              "error",
            )
            return true
          }
          config.thinkingLevel = level as (typeof LEVELS)[number]
          this.notice(`Global thinking → ${level}`)
        }
        return true
      }
      case "/stats": {
        if (id) {
          // Per-agent stats
          const p = this.registry.get(id)
          if (!p) {
            this.notice(`/stats: unknown participant "@${id}".`, "error")
            return true
          }
          const stats = p.getSessionStats?.()
          const ctx = p.getContextUsage?.()
          const parts: string[] = [`@${id}:`]
          if (stats) {
            const { input, output, cacheRead, total } = stats.tokens
            const cachePct =
              total > 0 ? Math.round((cacheRead / total) * 100) : 0
            parts.push(
              `${input}i / ${output}o · cache ${cachePct}% · ${stats.toolCalls} tools · ${stats.userMessages + stats.assistantMessages} msgs`,
            )
          }
          if (ctx) {
            parts.push(
              `context: ${ctx.tokens ?? "?"}/${ctx.contextWindow} (${ctx.percent ?? "?"}%)`,
            )
          }
          if (!stats && !ctx) parts.push("no stats yet")
          this.notice(parts.join(" · "))
        } else {
          // All agents summary
          for (const item of this.registry.roster()) {
            const p = this.registry.get(item.id)
            if (!p) continue
            const stats = p.getSessionStats?.()
            const ctx = p.getContextUsage?.()
            const parts: string[] = [`@${item.id}`]
            if (stats) {
              const { input, output, cacheRead, total } = stats.tokens
              const cachePct =
                total > 0 ? Math.round((cacheRead / total) * 100) : 0
              parts.push(
                `${input}i / ${output}o · cache ${cachePct}% · ${stats.toolCalls} tools`,
              )
            }
            if (ctx) {
              parts.push(`ctx ${ctx.percent ?? "?"}%`)
            }
            if (!stats && !ctx) parts.push("no stats yet")
            this.notice(parts.join(" · "))
          }
        }
        return true
      }
      case "/chaining": {
        const val = args[0]?.toLowerCase()
        if (val === "on") {
          this.setChaining(true)
          this.notice("Chaining → on")
        } else if (val === "off") {
          this.setChaining(false)
          this.notice("Chaining → off")
        } else {
          this.notice("/chaining: usage — /chaining on|off", "error")
        }
        return true
      }
      case "/default": {
        if (!rawTarget || rawTarget.toLowerCase() === "none") {
          this.setDefaultAgent(null)
          this.notice("Default agent → none (first active)")
        } else {
          const agentId = rawTarget.replace(/^@/, "").toLowerCase()
          try {
            this.setDefaultAgent(agentId)
            this.notice(`Default agent → @${agentId}`)
          } catch (err) {
            this.notice(
              `/default: ${err instanceof Error ? err.message : String(err)}`,
              "error",
            )
          }
        }
        return true
      }
      case "/fallback": {
        if (!rawTarget || rawTarget.toLowerCase() === "none") {
          this.setFallbackAgent(null)
          this.notice("Fallback routing → disabled")
        } else {
          const agentId = rawTarget.replace(/^@/, "").toLowerCase()
          try {
            this.setFallbackAgent(agentId)
            this.notice(`Fallback routing → @${agentId}`)
          } catch (err) {
            this.notice(
              `/fallback: ${err instanceof Error ? err.message : String(err)}`,
              "error",
            )
          }
        }
        return true
      }
      case "/provider": {
        const subCmd = args[0]?.toLowerCase()
        if (subCmd === "list" || !subCmd) {
          // List providers
          const providers = this.registry.getProviderList()
          const lines = providers.map(
            (p) =>
              `${p.configured ? "✓" : "○"} ${p.displayName} (${p.models} models)`,
          )
          this.notice(`Providers:\n${lines.join("\n")}`)
        } else if (subCmd === "add") {
          const providerName = args[1]
          const apiKey = args[2]
          if (!providerName || !apiKey) {
            this.notice(
              "/provider add: usage — /provider add <name> <api_key>",
              "error",
            )
          } else {
            try {
              await this.registry.setProviderKey(providerName, apiKey)
              this.notice(
                `Provider "${providerName}" configured. Models should now be available.`,
              )
            } catch (err) {
              this.notice(
                `/provider add failed: ${err instanceof Error ? err.message : String(err)}`,
                "error",
              )
            }
          }
        } else if (subCmd === "remove") {
          const providerName = args[1]
          if (!providerName) {
            this.notice(
              "/provider remove: usage — /provider remove <name>",
              "error",
            )
          } else {
            try {
              await this.registry.removeProviderKey(providerName)
              this.notice(`Provider "${providerName}" removed.`)
            } catch (err) {
              this.notice(
                `/provider remove failed: ${err instanceof Error ? err.message : String(err)}`,
                "error",
              )
            }
          }
        } else {
          this.notice(
            `/provider: unknown sub-command "${subCmd}". Use: list, add <name> <key>, remove <name>`,
            "error",
          )
        }
        return true
      }
      default:
        this.notice(`Unknown command "${cmd}".`, "error")
        return true
    }
  }
}
