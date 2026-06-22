// Resolve the shared model registry / auth storage and pick a model once at
// startup. All participants reuse these so we don't re-scan providers per agent.

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent"
import { config } from "./config.js"

export interface ResolvedModel {
  authStorage: AuthStorage
  modelRegistry: ModelRegistry
  /** undefined → let createAgentSession use pi's default resolution. */
  model: Awaited<ReturnType<ModelRegistry["getAvailable"]>>[number] | undefined
}

export async function resolveModel(): Promise<ResolvedModel> {
  const authStorage = AuthStorage.create()
  const modelRegistry = ModelRegistry.create(authStorage)

  let model: ResolvedModel["model"]

  if (config.modelOverride) {
    const slash = config.modelOverride.indexOf("/")
    const provider = slash >= 0 ? config.modelOverride.slice(0, slash) : ""
    const id = slash >= 0 ? config.modelOverride.slice(slash + 1) : config.modelOverride
    model = (modelRegistry.find(provider, id) as ResolvedModel["model"]) ?? undefined
    if (!model) {
      console.warn(`[model] override "${config.modelOverride}" not found; falling back to default`)
    }
  }

  if (!model) {
    const available = await modelRegistry.getAvailable()
    // This stack is local-only by policy: always prefer the `local` provider
    // (llama-server :5000) over any cloud model that happens to have a key.
    model = available.find((m) => m.provider === "local") ?? available[0]
  }

  if (model && model.provider !== "local") {
    console.warn(
      `[model] WARNING: resolved a non-local model (${model.provider}/${model.id}). ` +
        `This stack is meant to be local-only. Set PIPELINE_MODEL=local/<id> or check ~/.pi/agent/models.json.`,
    )
  }

  console.log(
    model
      ? `[model] using ${model.provider}/${model.id}`
      : `[model] no explicit model resolved; relying on pi defaults`,
  )

  return { authStorage, modelRegistry, model }
}

/** A model the UI can offer for per-agent selection. */
export interface ModelInfo {
  provider: string
  id: string
  /** "provider/id" — the value stored on a persona. */
  ref: string
  name: string
  local: boolean
}

/** Parse a "provider/id" ref into its parts. */
function splitRef(ref: string): { provider: string; id: string } {
  const slash = ref.indexOf("/")
  return slash >= 0
    ? { provider: ref.slice(0, slash), id: ref.slice(slash + 1) }
    : { provider: "", id: ref }
}

/** Models offered for per-agent selection: those with auth configured, filtered
 *  to local unless cloud is explicitly allowed (PIPELINE_ALLOW_CLOUD), or the
 *  provider has been explicitly enabled by the user via /api/providers. */
export function listModels(resolved: ResolvedModel, explicitlyEnabled?: Set<string>): ModelInfo[] {
  return resolved.modelRegistry
    .getAvailable()
    .filter((m) =>
      config.allowCloud || m.provider === "local" || (explicitlyEnabled?.has(m.provider) ?? false),
    )
    .map((m) => ({
      provider: m.provider,
      id: m.id,
      ref: `${m.provider}/${m.id}`,
      name: (m as { name?: string }).name ?? m.id,
      local: m.provider === "local",
    }))
}

/** True if a "provider/id" ref is a model the UI is allowed to assign. */
export function isAllowedModel(resolved: ResolvedModel, ref: string, explicitlyEnabled?: Set<string>): boolean {
  return listModels(resolved, explicitlyEnabled).some((m) => m.ref === ref)
}

/** Downgrade preset personas whose model isn't currently available to the
 *  process default (model → undefined) instead of blocking the whole load.
 *  Mutates `personas` in place and returns what was downgraded so the caller can
 *  surface it. Mirrors resolveModelRef's runtime fallback — a stale cloud id or a
 *  swapped local quant degrades gracefully rather than bricking every preset. */
export function downgradeUnavailableModels(
  personas: Array<{ name: string; model?: string }>,
  isAllowed: (ref: string) => boolean,
): Array<{ agent: string; model: string }> {
  const downgraded: Array<{ agent: string; model: string }> = []
  for (const p of personas) {
    if (p.model && !isAllowed(p.model)) {
      downgraded.push({ agent: p.name, model: p.model })
      p.model = undefined
    }
  }
  return downgraded
}

/** Resolve a persona's "provider/id" ref to a concrete model. Enforces the
 *  local-only policy: a non-local ref (or an unknown one) falls back to the
 *  process default rather than silently reaching the cloud. */
export function resolveModelRef(resolved: ResolvedModel, ref?: string): ResolvedModel["model"] {
  if (!ref) return resolved.model
  const { provider, id } = splitRef(ref)
  if (provider !== "local" && !config.allowCloud) {
    console.warn(
      `[model] persona model "${ref}" is non-local and PIPELINE_ALLOW_CLOUD is off — using default instead.`,
    )
    return resolved.model
  }
  const found = resolved.modelRegistry.find(provider, id) as ResolvedModel["model"]
  if (!found) {
    console.warn(`[model] persona model "${ref}" not found — using default.`)
    return resolved.model
  }
  return found
}
