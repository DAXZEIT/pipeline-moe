// Pipeline-MoE backend entry point.
//
// REST + SSE over Express. Manages a roster of stateful pi AgentSession
// instances (one per participant) sharing a workspace, routes @mentions to
// them via a serial queue, and streams everything to the UI over SSE.

import { createHash } from "node:crypto"
import { access, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { extname, join } from "node:path"
import cors from "cors"
import rateLimit from "express-rate-limit"
import express from "express"
import { config } from "./config.js"
import { isAllowedModel, listModels, resolveModel, type ResolvedModel } from "./model.js"
import { listWorkspace } from "./receipts.js"
import { BASE_PROMPT, BUILDER_OVERLAY, PLANNER_OVERLAY, SEED_PERSONAS } from "./personas.js"
import { Registry } from "./registry.js"
import { Room } from "./room.js"
import { SseHub } from "./sse.js"
import { ConversationStore } from "./store.js"
import type { Persona, PersonaState } from "./types.js"
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


// ── Preset I/O ──────────────────────────────────────────────────────────────

/** A persona as persisted in a preset file — systemPrompt is optional since
 *  seed personas rehydrate from SEED_PERSONAS at load time. */
interface PresetPersona extends Omit<PersonaState, "systemPrompt"> {
  systemPrompt?: string
}

/** A saved preset: roster configuration + metadata. */
interface PresetFile {
  name: string
  personas: PresetPersona[]
}

function presetsDir(): string {
  return join(config.workspaceDir, "presets")
}

function presetPath(name: string): string {
  return join(presetsDir(), `${name}.json`)
}

async function listPresets(): Promise<PresetFile[]> {
  await mkdir(presetsDir(), { recursive: true })
  const files = await readdir(presetsDir())
  const results: PresetFile[] = []
  for (const f of files) {
    if (!f.endsWith(".json")) continue
    try {
      const content = await readFile(presetPath(f.replace(".json", "")), "utf-8")
      const parsed = JSON.parse(content) as PresetFile
      results.push(parsed)
    } catch {
      // Skip corrupt files
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name))
}

async function readPreset(name: string): Promise<PresetFile | null> {
  const path = presetPath(name)
  try {
    const content = await readFile(path, "utf-8")
    return JSON.parse(content) as PresetFile
  } catch {
    return null
  }
}

async function writePreset(preset: PresetFile): Promise<void> {
  await mkdir(presetsDir(), { recursive: true })
  const content = JSON.stringify(preset, null, 2)
  await writeFile(presetPath(preset.name), content, "utf-8")
}

async function deletePreset(name: string): Promise<boolean> {
  const path = presetPath(name)
  try {
    await unlink(path)
    return true
  } catch {
    return false
  }
}

/** Strip systemPrompt from seed persona IDs so presets don't carry stale prompts. */
function stripSeedPrompts(personas: (PersonaState | PresetPersona)[]): PresetPersona[] {
  const seedIds = new Set(SEED_PERSONAS.map(p => p.id))
  return personas.map(p => {
    if (seedIds.has(p.id)) {
      const { systemPrompt: _, ...rest } = p
      return rest
    }
    return p as PresetPersona
  })
}

/** Rehydrate systemPrompt from current SEED_PERSONAS for matching IDs. */
function rehydratePrompts(personas: PresetPersona[]): PersonaState[] {
  const seedMap = new Map(SEED_PERSONAS.map(p => [p.id, p]))
  return personas.map(p => {
    const seed = seedMap.get(p.id)
    if (seed && !p.systemPrompt) {
      return { ...p, systemPrompt: seed.systemPrompt }
    }
    return p as PersonaState
  })
}

/** Re-seed any missing default presets (allows user deletion, restored on restart). */
async function seedDefaultPresets(): Promise<void> {
  const existing = await listPresets()
  const existingNames = new Set(existing.map(p => p.name))

  const localDefault: PresetFile = {
    name: "local-default",
    personas: stripSeedPrompts(SEED_PERSONAS.map(p => ({ ...p, active: true, parallel: false }))),
  }

  // Cloud-sprint: builder2 (Haiku), auditor (Sonnet), planner (Opus), tester (Sonnet)
  const cloudSprint: PresetFile = {
    name: "cloud-sprint",
    personas: stripSeedPrompts([
      {
        id: "builder2",
        name: "Builder2",
        color: "#EF9F27",
        icon: "🔨",
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        systemPrompt: BASE_PROMPT + BUILDER_OVERLAY,
        model: "anthropic/claude-haiku-4-20250719",
        active: true,
        parallel: true,
      },
      {
        id: "auditor",
        name: "Auditor",
        color: "#AFA9EC",
        icon: "🛡️",
        tools: ["read", "grep", "find", "ls"],
        model: "anthropic/claude-sonnet-4-20250514",
        active: true,
        parallel: true,
      },
      {
        id: "planner",
        name: "Planner",
        color: "#4A90D9",
        icon: "📋",
        tools: ["read", "grep", "find", "ls"],
        systemPrompt: BASE_PROMPT + PLANNER_OVERLAY,
        model: "anthropic/claude-opus-4-6-20250603",
        active: true,
        parallel: true,
      },
      {
        id: "tester",
        name: "Tester",
        color: "#97C459",
        icon: "🧪",
        tools: ["read", "bash", "grep", "find", "ls"],
        model: "anthropic/claude-sonnet-4-20250514",
        active: true,
        parallel: true,
      },
    ]),
  }

  let seeded = 0
  if (!existingNames.has("local-default")) {
    await writePreset(localDefault)
    seeded++
  }
  if (!existingNames.has("cloud-sprint")) {
    await writePreset(cloudSprint)
    seeded++
  }
  if (seeded > 0) {
    console.log(`[presets] seeded ${seeded} default preset(s)`)
  }
}

/** Build the provider list for SSE broadcast and API responses. */
async function getProviderList(resolved: ResolvedModel, explicitlyEnabled: Set<string>) {
  const allModels = resolved.modelRegistry.getAll()
  const providerSet = new Set(allModels.map((m) => m.provider))
  // Pre-compute which providers support OAuth login
  const oauthProviderIds = new Set(
    resolved.authStorage.getOAuthProviders().map((p) => p.id),
  )
  return Array.from(providerSet).map((name) => {
    const authStatus = resolved.modelRegistry.getProviderAuthStatus(name)
    const models = allModels
      .filter((m) => m.provider === name)
      .map((m) => ({ id: m.id, name: (m as { name?: string }).name ?? m.id }))
    return {
      name,
      displayName: resolved.modelRegistry.getProviderDisplayName(name),
      ...authStatus,
      explicitlyEnabled: explicitlyEnabled.has(name),
      supportsOAuth: oauthProviderIds.has(name),
      models,
    }
  })
}

async function main(): Promise<void> {
  await mkdir(config.workspaceDir, { recursive: true })
  await mkdir(mediaDir(), { recursive: true })

  const resolved = await resolveModel()
  const hub = new SseHub()

  // Track providers the user has explicitly added via the API — their models
  // appear in listModels() even when PIPELINE_ALLOW_CLOUD is false.
  const explicitlyEnabledProviders = new Set<string>()

  const registry = new Registry(resolved, hub, explicitlyEnabledProviders)
  const store = new ConversationStore()
  const room = new Room(registry, hub, store, SEED_PERSONAS)

  // Load the most recent saved discussion, or seed a fresh one.
  await room.init()
  await seedDefaultPresets()
  console.log(`[room] roster: ${registry.roster().length} participants`)

  const app = express()
  app.use(cors({ origin: config.corsOrigins }))
  app.use(express.json({ limit: "5mb" }))

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, workspace: config.workspaceDir, clients: hub.clientCount })
  })

  // ── Presets ────────────────────────────────────────────────────────────────

  app.get("/api/presets", async (_req, res) => {
    try {
      const presets = await listPresets()
      res.json(presets)
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post("/api/presets", async (req, res) => {
    const name = String(req.body?.name ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "")
    if (!name) {
      res.status(400).json({ error: "`name` is required (alphanumeric, dash, underscore)" })
      return
    }
    if (room.isBusy()) {
      res.status(409).json({ error: "a turn is running — press Stop before saving a preset" })
      return
    }
    try {
      const personas = stripSeedPrompts(registry.personaStates())
      const preset: PresetFile = { name, personas }
      await writePreset(preset)
      res.status(201).json(preset)
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete("/api/presets/:name", async (req, res) => {
    const name = req.params.name
    const deleted = await deletePreset(name)
    if (!deleted) {
      res.status(404).json({ error: `preset "${name}" not found` })
      return
    }
    res.status(204).end()
  })

  app.post("/api/presets/:name/load", async (req, res) => {
    const name = req.params.name
    if (room.isBusy()) {
      res.status(409).json({ error: "a turn is running — press Stop before loading a preset" })
      return
    }
    try {
      const preset = await readPreset(name)
      if (!preset) {
        res.status(404).json({ error: `preset "${name}" not found` })
        return
      }

      // Rehydrate systemPrompts from current SEED_PERSONAS
      const personas = rehydratePrompts(preset.personas)

      // Guard: empty roster would brick the session
      if (personas.length === 0) {
        res.status(400).json({ error: `preset "${name}" has no personas — would brick the session` })
        return
      }

      // Validate: all model refs must be available
      const missingModels: string[] = []
      for (const p of personas) {
        if (p.model && !isAllowedModel(resolved, p.model, explicitlyEnabledProviders)) {
          const reason = config.allowCloud
            ? `model "${p.model}" not found`
            : `model "${p.model}" unavailable — cloud is disabled (set PIPELINE_ALLOW_CLOUD=1)`
          missingModels.push(reason)
        }
      }
      if (missingModels.length > 0) {
        res.status(400).json({ error: "unavailable models in preset:", details: missingModels })
        return
      }

      const meta = await room.loadPreset(personas, `${name} — ${new Date().toLocaleTimeString()}`)
      res.json({ ok: true, conversation: meta })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.status(msg.includes("unknown") ? 404 : 409).json({ error: msg })
    }
  })

  // ── Apply preset roster to current room (in-place, no new conversation) ──

  app.post("/api/presets/:name/apply", async (req, res) => {
    const name = req.params.name
    if (room.isBusy()) {
      res.status(409).json({ error: "a turn is running — press Stop before applying a preset" })
      return
    }
    try {
      const preset = await readPreset(name)
      if (!preset) {
        res.status(404).json({ error: `preset "${name}" not found` })
        return
      }

      // Rehydrate systemPrompts from current SEED_PERSONAS
      const personas = rehydratePrompts(preset.personas)

      // Guard: empty roster would brick the session
      if (personas.length === 0) {
        res.status(400).json({ error: `preset "${name}" has no personas — would brick the session` })
        return
      }

      // Validate: all model refs must be available
      const missingModels: string[] = []
      for (const p of personas) {
        if (p.model && !isAllowedModel(resolved, p.model, explicitlyEnabledProviders)) {
          const reason = config.allowCloud
            ? `model "${p.model}" not found`
            : `model "${p.model}" unavailable — cloud is disabled (set PIPELINE_ALLOW_CLOUD=1)`
          missingModels.push(reason)
        }
      }
      if (missingModels.length > 0) {
        res.status(400).json({ error: "unavailable models in preset:", details: missingModels })
        return
      }

      const meta = await room.applyPreset(personas)
      res.json({ ok: true, conversation: meta })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.status(msg.includes("unknown") ? 404 : 409).json({ error: msg })
    }
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

  // Models offered for per-agent selection (local-only unless PIPELINE_ALLOW_CLOUD,
  // or the provider has been explicitly enabled by the user via /api/providers).
  app.get("/api/models", (_req, res) => {
    const models = listModels(resolved, explicitlyEnabledProviders)
    res.json({ models, allowCloud: config.allowCloud })
  })

  // ── Providers ──────────────────────────────────────────────────────────────

  // List all known providers with their auth status (no secrets exposed).
  app.get("/api/providers", (_req, res) => {
    const allModels = resolved.modelRegistry.getAll()
    const providerSet = new Set(allModels.map((m) => m.provider))
    const providers = Array.from(providerSet).map((name) => {
      const authStatus = resolved.modelRegistry.getProviderAuthStatus(name)
      const models = allModels
        .filter((m) => m.provider === name)
        .map((m) => ({ id: m.id, name: (m as { name?: string }).name ?? m.id }))
      return {
        name,
        displayName: resolved.modelRegistry.getProviderDisplayName(name),
        ...authStatus,
        explicitlyEnabled: explicitlyEnabledProviders.has(name),
        models,
      }
    })
    res.json({ providers, explicitlyEnabled: Array.from(explicitlyEnabledProviders) })
  })

  // Set an API key for a provider (persisted to auth.json).
  app.post("/api/providers/:name", async (req, res) => {
    const name = req.params.name
    const body = req.body ?? {}

    if (!body.key || typeof body.key !== "string") {
      res.status(400).json({ error: "`key` is required (string)" })
      return
    }
    if (room.isBusy()) {
      res.status(409).json({ error: "a turn is running — press Stop before changing provider credentials" })
      return
    }

    // Verify the provider exists in the registry
    const allModels = resolved.modelRegistry.getAll()
    const providerExists = allModels.some((m) => m.provider === name)
    if (!providerExists && !body.baseUrl) {
      res.status(404).json({ error: `provider "${name}" not found in model registry` })
      return
    }

    try {
      resolved.authStorage.set(name, { type: "api_key", key: body.key })
      explicitlyEnabledProviders.add(name)
      // Refresh so getAvailable() picks up the new models immediately
      resolved.modelRegistry.refresh()

      // Broadcast updated provider list to SSE clients
      hub.broadcast("providers", {
        providers: await getProviderList(resolved, explicitlyEnabledProviders),
        explicitlyEnabled: Array.from(explicitlyEnabledProviders),
      })

      // Return only the auth status — never the key
      const status = resolved.modelRegistry.getProviderAuthStatus(name)
      res.status(200).json({ name, ...status })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // Start OAuth login flow for a provider (device-code or auth URL).
  app.post("/api/providers/:name/login", async (req, res) => {
    const name = req.params.name
    const oauthProviders = resolved.authStorage.getOAuthProviders()
    const oauthProvider = oauthProviders.find((p) => p.id === name)
    if (!oauthProvider) {
      res.status(404).json({ error: `provider "${name}" does not support OAuth login` })
      return
    }
    if (room.isBusy()) {
      res.status(409).json({ error: "a turn is running — press Stop before starting OAuth login" })
      return
    }

    // Start the login flow in the background — communicate progress via SSE.
    // Return 202 immediately so the client can wait for SSE events.
    const providerName = name // capture for closure
    setImmediate(async () => {
      try {
        await resolved.authStorage.login(name, {
          onDeviceCode: (info) => {
            hub.broadcast("oauth_progress", {
              provider: providerName,
              type: "device_code",
              userCode: info.userCode,
              verificationUri: info.verificationUri,
            })
          },
          onAuth: (info) => {
            hub.broadcast("oauth_progress", {
              provider: providerName,
              type: "auth_url",
              url: info.url,
              instructions: info.instructions,
            })
          },
          onProgress: (message) => {
            hub.broadcast("oauth_progress", {
              provider: providerName,
              type: "progress",
              message,
            })
          },
          onPrompt: async (prompt) => {
            // For headless: reject prompts that require user input
            hub.broadcast("oauth_progress", {
              provider: providerName,
              type: "error",
              message: `OAuth requires interactive prompt: "${prompt.message}" — use the pi CLI for this provider.`,
            })
            throw new Error("interactive prompt not supported in headless mode")
          },
          onSelect: async () => {
            hub.broadcast("oauth_progress", {
              provider: providerName,
              type: "error",
              message: "OAuth requires a selection — use the pi CLI for this provider.",
            })
            throw new Error("interactive selection not supported in headless mode")
          },
        })

        // Success — broadcast updated provider list
        resolved.modelRegistry.refresh()
        hub.broadcast("providers", {
          providers: await getProviderList(resolved, explicitlyEnabledProviders),
          explicitlyEnabled: Array.from(explicitlyEnabledProviders),
        })
        hub.broadcast("oauth_progress", {
          provider: providerName,
          type: "success",
          message: `Authenticated with ${providerName}.`,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        hub.broadcast("oauth_progress", {
          provider: providerName,
          type: "error",
          message: msg,
        })
      }
    })

    res.status(202).json({ accepted: true, provider: name })
  })

  // Remove credentials for a provider.
  app.delete("/api/providers/:name", async (req, res) => {
    const name = req.params.name
    if (name === "local") {
      res.status(400).json({ error: "cannot remove the local provider" })
      return
    }
    if (room.isBusy()) {
      res.status(409).json({ error: "a turn is running — press Stop before changing provider credentials" })
      return
    }

    // Check if any active participant uses this provider
    const roster = registry.roster()
    const agentsUsing = roster.filter((p) => {
      const model = p.model
      return model && model.startsWith(`${name}/`)
    }).map((p) => p.name)

    try {
      resolved.authStorage.remove(name)
      explicitlyEnabledProviders.delete(name)
      resolved.modelRegistry.refresh()

      hub.broadcast("providers", {
        providers: await getProviderList(resolved, explicitlyEnabledProviders),
        explicitlyEnabled: Array.from(explicitlyEnabledProviders),
      })

      const status = resolved.modelRegistry.getProviderAuthStatus(name)
      res.status(200).json({ name, ...status, agentsUsing })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
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
      } else if (typeof mv === "string" && isAllowedModel(resolved, mv, explicitlyEnabledProviders)) {
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
    if ("compactionInstructions" in body) {
      const ci = body.compactionInstructions
      if (ci === null || ci === "") {
        patch.compactionInstructions = undefined
      } else if (typeof ci === "string" && ci.length <= 500) {
        patch.compactionInstructions = ci
      } else if (typeof ci === "string") {
        res.status(400).json({ error: `compactionInstructions too long (${ci.length} chars, max 500)` })
        return
      } else {
        res.status(400).json({ error: "compactionInstructions must be a string" })
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
    res.json({ chaining: room.getChaining(), defaultAgent: room.getDefaultAgent(), fallbackAgent: room.getFallbackAgent(), maxChainHops: room.getMaxChainHops() })
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
    if ("fallbackAgent" in body) {
      const fa = body.fallbackAgent
      if (fa !== null && typeof fa !== "string") {
        res.status(400).json({ error: "`fallbackAgent` must be a string id or null" })
        return
      }
      try {
        room.setFallbackAgent(fa)
      } catch (err) {
        res.status(404).json({ error: err instanceof Error ? err.message : String(err) })
        return
      }
    }
    if ("maxChainHops" in body) {
      const n = body.maxChainHops
      if (typeof n !== "number" || n < 1 || n > 100) {
        res.status(400).json({ error: "`maxChainHops` must be a number between 1 and 100" })
        return
      }
      room.setMaxChainHops(n)
    }
    res.json({ chaining: room.getChaining(), defaultAgent: room.getDefaultAgent(), fallbackAgent: room.getFallbackAgent(), maxChainHops: room.getMaxChainHops() })
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

  // Export agent's session as JSONL (one JSON object per line).
  app.get("/api/participants/:id/export-jsonl", (req, res) => {
    const { id } = req.params
    const p = registry.get(id)
    if (!p) {
      res.status(404).json({ error: `unknown participant "${id}"` })
      return
    }
    try {
      const filePath = p.exportToJsonl()
      const jsonl = readFileSync(filePath, "utf-8")
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5)
      const filename = `${id}-${timestamp}.jsonl`
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8")
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
      res.send(jsonl)
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
