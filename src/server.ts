// Pipeline-MoE backend entry point.
//
// REST + SSE over Express. Manages a roster of stateful pi AgentSession
// instances (one per participant) sharing a workspace, routes @mentions to
// them via a serial queue, and streams everything to the UI over SSE.

import { createHash } from "node:crypto"
import { access, mkdir, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { extname, join } from "node:path"
import cors from "cors"
import rateLimit from "express-rate-limit"
import express from "express"
import { config } from "./config.js"
import { isAllowedModel, listModels, resolveModel } from "./model.js"
import { listWorkspace } from "./receipts.js"
import { SEED_PERSONAS } from "./personas.js"
import { Registry } from "./registry.js"
import { Room } from "./room.js"
import { SseHub } from "./sse.js"
import { ConversationStore } from "./store.js"
import type { Persona } from "./types.js"
import { parsePersona, VALID_TOOLS } from "./validation.js"

/** Directory for saved user images (relative to workspace). */
function mediaDir(): string {
  return join(config.workspaceDir, "media")
}

/** Resolve a base64 data URI to a saved file path, returning the workspace-relative path. */
async function saveImage(uri: string): Promise<string> {
  // Parse "data:image/png;base64,ABCD" → { ext: "png", data: "ABCD" }
  const match = uri.match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+\/=]+)$/)
  if (!match) throw new Error(`unsupported image format: ${uri.slice(0, 30)}...`);
  const [, ext, b64] = match
  const hash = createHash("md5").update(b64).digest("hex").slice(0, 12)
  const fileName = `${hash}.${ext}`
  const filePath = join(mediaDir(), fileName)
  await writeFile(filePath, Buffer.from(b64, "base64"))
  return `media/${fileName}`
}

async function saveIncomingImages(images: unknown): Promise<string[]> {
  if (!Array.isArray(images)) return []
  const results: string[] = []
  for (const uri of images) {
    if (typeof uri !== "string") continue
    try {
      results.push(await saveImage(uri))
    } catch (err) {
      // Skip images that fail to save; the message still goes through.
      console.warn(`[server] image save failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return results
}


async function main(): Promise<void> {
  await mkdir(config.workspaceDir, { recursive: true })
  await mkdir(mediaDir(), { recursive: true })

  const resolved = await resolveModel()
  const hub = new SseHub()
  const registry = new Registry(resolved, hub)
  const store = new ConversationStore()
  const room = new Room(registry, hub, store, SEED_PERSONAS)

  // Load the most recent saved discussion, or seed a fresh one.
  await room.init()
  console.log(`[room] roster: ${registry.roster().length} participants`)

  const app = express()
  app.use(cors({ origin: ["http://localhost:5310", "http://localhost:5300"] }))
  app.use(express.json({ limit: "5mb" }))

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, workspace: config.workspaceDir, clients: hub.clientCount })
  })

  // Serve saved images from the media directory.
  app.get("/api/media/:filename", async (req, res) => {
    const filename = req.params.filename
    const ext = extname(filename).toLowerCase()
    const allowed = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"])
    if (!allowed.has(ext)) {
      res.status(400).json({ error: "unsupported file type" })
      return
    }
    const filePath = join(mediaDir(), filename)
    try {
      await access(filePath)
      res.sendFile(filePath)
    } catch {
      res.status(404).json({ error: "image not found" })
    }
  })

  // SSE stream of all room events.
  app.get("/api/events", (_req, res) => {
    hub.addClient(res)
    // Send the current roster immediately so a fresh client can render.
    hub.broadcast("roster", registry.roster())
  })

  app.get("/api/participants", (_req, res) => {
    res.json(registry.roster())
  })

  // Models offered for per-agent selection (local-only unless PIPELINE_ALLOW_CLOUD).
  app.get("/api/models", (_req, res) => {
    res.json({ models: listModels(resolved), allowCloud: config.allowCloud })
  })

  app.post("/api/participants", async (req, res) => {
    try {
      const persona = parsePersona(req.body ?? {})
      if (registry.has(persona.id)) {
        res.status(409).json({ error: `participant "${persona.id}" already exists` })
        return
      }
      await registry.create(persona)
      res.status(201).json(registry.roster().find((r) => r.id === persona.id))
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // Reorder the roster (first-turn / @all execution order). Registered before
  // the "/:id" routes so "reorder" is never parsed as an id.
  app.post("/api/participants/reorder", (req, res) => {
    const order = req.body?.order
    if (!Array.isArray(order) || !order.every((x: unknown) => typeof x === "string")) {
      res.status(400).json({ error: "`order` must be an array of participant ids" })
      return
    }
    registry.reorder(order as string[])
    res.json(registry.roster())
  })

  // Full persona (incl. systemPrompt) for the edit form.
  app.get("/api/participants/:id", (req, res) => {
    const p = registry.get(req.params.id)
    if (!p) {
      res.status(404).json({ error: `unknown participant "${req.params.id}"` })
      return
    }
    res.json({ ...p.persona, availableThinkingLevels: p.getAvailableThinkingLevels() })
  })

  // Activate / deactivate AND edit persona (name, prompt, tools, color, icon).
  app.patch("/api/participants/:id", async (req, res) => {
    const { id } = req.params
    if (!registry.has(id)) {
      res.status(404).json({ error: `unknown participant "${id}"` })
      return
    }
    const body = req.body ?? {}

    // Build a persona patch from any editable fields present in the body.
    const patch: Record<string, unknown> = {}
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim()
    if (typeof body.systemPrompt === "string" && body.systemPrompt.trim())
      patch.systemPrompt = body.systemPrompt.trim()
    if (typeof body.color === "string") patch.color = body.color
    if (typeof body.icon === "string") patch.icon = body.icon
    if (Array.isArray(body.tools))
      patch.tools = body.tools.map(String).filter((t: string) => VALID_TOOLS.has(t))
    const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"])
    if ("thinkingLevel" in body) {
      const tv = body.thinkingLevel
      if (tv === null || tv === "") {
        patch.thinkingLevel = undefined // reset to the global default
      } else if (typeof tv === "string" && VALID_THINKING.has(tv)) {
        patch.thinkingLevel = tv
      } else {
        res.status(400).json({ error: `invalid thinkingLevel "${String(tv)}" — must be one of: off, minimal, low, medium, high, xhigh` })
        return
      }
    }
    if ("model" in body) {
      const mv = body.model
      if (mv === null || mv === "") {
        patch.model = undefined // reset to the process default model
      } else if (typeof mv === "string" && isAllowedModel(resolved, mv)) {
        patch.model = mv
      } else {
        res.status(400).json({
          error: config.allowCloud
            ? `unknown model "${String(mv)}"`
            : `model "${String(mv)}" unavailable — cloud is disabled (set PIPELINE_ALLOW_CLOUD=1 to enable)`,
        })
        return
      }
    }

    try {
      if (typeof body.active === "boolean") registry.setActive(id, body.active)
      if (typeof body.parallel === "boolean") registry.setParallel(id, body.parallel)
      if (Object.keys(patch).length > 0) {
        // Fast path: thinkingLevel-only change → in-place, no session recreation.
        if (Object.keys(patch).length === 1 && "thinkingLevel" in patch && patch.thinkingLevel !== undefined) {
          const level = patch.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
          await registry.setThinkingLevel(id, level)
        } else {
          // Heavy path: dispose + recreate session.
          if (room.isBusy()) {
            res.status(409).json({ error: "a turn is running — press Stop before editing an agent" })
            return
          }
          await registry.update(id, patch)
        }
      }
      res.json(registry.roster().find((r) => r.id === id))
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete("/api/participants/:id", (req, res) => {
    const { id } = req.params
    if (!registry.has(id)) {
      res.status(404).json({ error: `unknown participant "${id}"` })
      return
    }
    registry.kick(id)
    res.status(204).end()
  })

  app.get("/api/transcript", (_req, res) => {
    res.json(room.getTranscript())
  })

  app.get("/api/workspace", async (_req, res) => {
    res.json(await listWorkspace(config.workspaceDir))
  })

  // ── Conversations (saved group discussions) ───────────────────────────────
  app.get("/api/conversations", async (_req, res) => {
    res.json(await room.getConversations())
  })

  app.post("/api/conversations", async (req, res) => {
    try {
      const title = req.body?.title ? String(req.body.title) : undefined
      res.status(201).json(await room.newConversation(title))
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post("/api/conversations/:id/load", async (req, res) => {
    try {
      await room.switchConversation(req.params.id)
      res.json({ ok: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.status(msg.includes("unknown") ? 404 : 409).json({ error: msg })
    }
  })

  app.patch("/api/conversations/:id", async (req, res) => {
    const title = String(req.body?.title ?? "").trim()
    if (!title) {
      res.status(400).json({ error: "`title` is required" })
      return
    }
    try {
      await room.renameConversation(req.params.id, title)
      res.json({ ok: true })
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete("/api/conversations/:id", async (req, res) => {
    try {
      await room.deleteConversation(req.params.id)
      res.status(204).end()
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get("/api/settings", (_req, res) => {
    res.json({ chaining: room.getChaining(), defaultAgent: room.getDefaultAgent() })
  })

  app.patch("/api/settings", (req, res) => {
    const body = req.body ?? {}
    if ("chaining" in body) {
      if (typeof body.chaining !== "boolean") {
        res.status(400).json({ error: "`chaining` must be a boolean" })
        return
      }
      room.setChaining(body.chaining)
    }
    if ("defaultAgent" in body) {
      const da = body.defaultAgent
      if (da !== null && typeof da !== "string") {
        res.status(400).json({ error: "`defaultAgent` must be a string id or null" })
        return
      }
      try {
        room.setDefaultAgent(da)
      } catch (err) {
        res.status(404).json({ error: err instanceof Error ? err.message : String(err) })
        return
      }
    }
    res.json({ chaining: room.getChaining(), defaultAgent: room.getDefaultAgent() })
  })

  // Post a message to the room. Returns immediately; results stream over SSE.
  // Rate limited to prevent agent loops from flooding the queue.
  app.post("/api/messages", rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
    const text = String(req.body?.text ?? "").trim()
    if (!text) {
      res.status(400).json({ error: "`text` is required" })
      return
    }
    // Save images and resolve to workspace-relative paths.
    const images = await saveIncomingImages(req.body?.images)
    room.submit(text, images.length > 0 ? images : undefined)
    res.status(202).json({ accepted: true })
  })

  // Compact a specific agent's session context.
  app.post("/api/participants/:id/compact", async (req, res) => {
    const { id } = req.params
    const p = registry.get(id)
    if (!p) {
      res.status(404).json({ error: `unknown participant "${id}"` })
      return
    }
    if (room.isBusy()) {
      res.status(409).json({ error: "a turn is running — press Stop before compacting" })
      return
    }
    try {
      const result = await p.compact()
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // Export agent's session as self-contained HTML.
  app.get("/api/participants/:id/export", async (req, res) => {
    const { id } = req.params
    const p = registry.get(id)
    if (!p) {
      res.status(404).json({ error: `unknown participant "${id}"` })
      return
    }
    try {
      const filePath = await p.exportToHtml()
      const html = readFileSync(filePath, "utf-8")
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5)
      const filename = `${id}-${timestamp}.html`
      res.setHeader("Content-Type", "text/html; charset=utf-8")
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
      res.send(html)
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post("/api/abort", async (_req, res) => {
    const aborted = await room.abortCurrent()
    res.json({ aborted })
  })

  // Steer a running agent mid-turn.
  app.post("/api/messages/steer", async (req, res) => {
    const { text, target } = req.body
    if (!text || !target) {
      res.status(400).json({ error: "`text` and `target` are required" })
      return
    }
    try {
      await room.steer(target, String(text).trim())
      res.json({ ok: true, target, text: String(text).trim() })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("not running") || msg.includes("cannot steer")) {
        res.status(409).json({ error: msg })
      } else if (msg.includes("unknown participant")) {
        res.status(404).json({ error: msg })
      } else {
        res.status(500).json({ error: msg })
      }
    }
  })

  const server = app.listen(config.port, "127.0.0.1", () => {
    console.log(`[server] Pipeline-MoE listening on http://localhost:${config.port}`)
    console.log(`[server] workspace: ${config.workspaceDir}`)
  })

  const shutdown = () => {
    console.log("\n[server] shutting down…")
    registry.disposeAll()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  console.error("[fatal]", err)
  process.exit(1)
})
