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

// Isolation includes the NETWORK, not just the two files. `ModelRuntime.create`
// sets its network flag from `process.env.PI_OFFLINE === undefined` (pi 0.82
// model-runtime.js:71) — so it is ON by default, and every credential write
// goes through `login() → refresh() → GET pi.dev/api/models/providers/<name>`.
// That made the provider tests depend on a third party: ~800ms when pi.dev
// answers, a hang past the 5s test timeout when it does not. Read as "flaky
// under load"; it was never load. Set before any create() call — pi reads the
// variable at construction. `??=` so a caller can still opt back in.
process.env.PI_OFFLINE ??= "1"

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
