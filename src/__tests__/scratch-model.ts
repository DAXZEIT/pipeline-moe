// A ResolvedModel backed by throwaway auth.json / models.json, for tests that
// exercise the provider surface (keys, availability, auth status) without
// touching the developer's real ~/.pi/agent.
//
// It exists because pi 0.82 changed how that pair is built — `AuthStorage.create`
// + `ModelRegistry.create` became `ModelRuntime.create` + `new ModelRegistry` —
// and six test files were each carrying their own copy of the two lines. One
// copy means the next pi bump is one edit.

import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { ResolvedModel } from "../model.js"

/** Build a ResolvedModel isolated to `dir`. The registry is refreshed before it
 *  is handed back: its reads are synchronous and serve the last refresh, so a
 *  caller that skipped this would see an empty catalog. */
export async function scratchResolvedModel(dir: string): Promise<ResolvedModel> {
  const modelRuntime = await ModelRuntime.create({
    authPath: `${dir}/auth.json`,
    modelsPath: `${dir}/models.json`,
  })
  const modelRegistry = new ModelRegistry(modelRuntime)
  await modelRegistry.refresh()
  return { modelRuntime, modelRegistry, model: undefined }
}
