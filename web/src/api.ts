import type {
  ConversationMeta,
  Message,
  ModelInfo,
  PersonaDetail,
  PresetFile,
  ProviderInfo,
  RoomSummary,
  RosterItem,
  WorkspaceFile,
} from "./types"

export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:5300"

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = ""
    try {
      detail = (await res.json()).error ?? ""
    } catch {
      /* ignore */
    }
    throw new Error(detail || `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

/**
 * Create a room-scoped API object for the given route prefix.
 * Use prefix "/api" for the default room (backward compat).
 * Use "/api/rooms/:roomId" for non-default rooms.
 */
export function makeRoomApi(prefix: string) {
  const base = `${API_BASE}${prefix}`
  return {
    roster: () => fetch(`${base}/participants`).then((r) => json<RosterItem[]>(r)),
    transcript: () => fetch(`${base}/transcript`).then((r) => json<Message[]>(r)),
    workspace: () => fetch(`${base}/workspace`).then((r) => json<WorkspaceFile[]>(r)),

    sendMessage: (text: string, images?: string[]) =>
      fetch(`${base}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, ...(images && images.length > 0 ? { images } : {}) }),
      }).then((r) => json<{ accepted: boolean }>(r)),

    setActive: (id: string, active: boolean) =>
      fetch(`${base}/participants/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      }).then((r) => json<RosterItem>(r)),

    setParallel: (id: string, parallel: boolean) =>
      fetch(`${base}/participants/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parallel }),
      }).then((r) => json<RosterItem>(r)),

    kick: (id: string) =>
      fetch(`${base}/participants/${id}`, { method: "DELETE" }).then((r) => {
        if (!r.ok && r.status !== 204) throw new Error(`${r.status}`)
      }),

    participant: (id: string) =>
      fetch(`${base}/participants/${id}`).then((r) => json<PersonaDetail>(r)),

    updateAgent: (
      id: string,
      patch: {
        name?: string
        systemPrompt?: string
        tools?: string[]
        color?: string
        icon?: string
        model?: string | null
        thinkingLevel?: string | null
        compactionInstructions?: string | null
      },
    ) =>
      fetch(`${base}/participants/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).then((r) => json<RosterItem>(r)),

    reorder: (order: string[]) =>
      fetch(`${base}/participants/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order }),
      }).then((r) => json<RosterItem[]>(r)),

    create: (body: {
      name: string
      systemPrompt: string
      tools?: string[]
      color?: string
      icon?: string
      id?: string
    }) =>
      fetch(`${base}/participants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => json<RosterItem>(r)),

    abort: () => fetch(`${base}/abort`, { method: "POST" }).then((r) => json(r)),

    steerMessage: (text: string, target: string) =>
      fetch(`${base}/messages/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, target }),
      }).then((r) => json<{ ok: boolean; target: string; text: string }>(r)),

    compact: (id: string) =>
      fetch(`${base}/participants/${id}/compact`, { method: "POST" }).then((r) =>
        json<{ summary: string; tokensBefore: number }>(r),
      ),

    exportAgent: (id: string) =>
      fetch(`${base}/participants/${id}/export`).then((r) => r.blob()),

    exportAgentJsonl: (id: string) =>
      fetch(`${base}/participants/${id}/export-jsonl`).then((r) => r.blob()),

    settings: () =>
      fetch(`${base}/settings`).then((r) =>
        json<{ chaining: boolean; defaultAgent: string | null; maxChainHops: number }>(r),
      ),

    setChaining: (chaining: boolean) =>
      fetch(`${base}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chaining }),
      }).then((r) => json<{ chaining: boolean; defaultAgent: string | null; maxChainHops: number }>(r)),

    setDefaultAgent: (defaultAgent: string | null) =>
      fetch(`${base}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultAgent }),
      }).then((r) => json<{ chaining: boolean; defaultAgent: string | null; maxChainHops: number }>(r)),

    setMaxChainHops: (maxChainHops: number) =>
      fetch(`${base}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxChainHops }),
      }).then((r) => json<{ chaining: boolean; defaultAgent: string | null; maxChainHops: number }>(r)),

    conversations: () =>
      fetch(`${base}/conversations`).then((r) =>
        json<{ currentId: string; list: ConversationMeta[] }>(r),
      ),

    newConversation: (title?: string) =>
      fetch(`${base}/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(title ? { title } : {}),
      }).then((r) => json<ConversationMeta>(r)),

    loadConversation: (id: string) =>
      fetch(`${base}/conversations/${id}/load`, { method: "POST" }).then((r) =>
        json<{ ok: boolean }>(r),
      ),

    renameConversation: (id: string, title: string) =>
      fetch(`${base}/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      }).then((r) => json<{ ok: boolean }>(r)),

    deleteConversation: (id: string) =>
      fetch(`${base}/conversations/${id}`, { method: "DELETE" }).then((r) => {
        if (!r.ok && r.status !== 204) throw new Error(`${r.status}`)
      }),
  }
}

export const api = {
  // Room-scoped operations via the default /api prefix (backward compat).
  ...makeRoomApi("/api"),

  // ── Models (process-global) ─────────────────────────────────────────────

  models: () =>
    fetch(`${API_BASE}/api/models`).then((r) =>
      json<{ models: ModelInfo[]; allowCloud: boolean }>(r),
    ),

  // ── Presets (process-global) ────────────────────────────────────────────

  presets: () =>
    fetch(`${API_BASE}/api/presets`).then((r) => json<PresetFile[]>(r)),

  savePreset: (name: string) =>
    fetch(`${API_BASE}/api/presets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((r) => json<PresetFile>(r)),

  deletePreset: (name: string) =>
    fetch(`${API_BASE}/api/presets/${name}`, { method: "DELETE" }).then((r) => {
      if (!r.ok && r.status !== 204) throw new Error(`${r.status}`)
    }),

  loadPreset: (name: string) =>
    fetch(`${API_BASE}/api/presets/${name}/load`, { method: "POST" }).then((r) =>
      json<{ ok: boolean; conversation: ConversationMeta }>(r),
    ),

  applyPreset: (name: string) =>
    fetch(`${API_BASE}/api/presets/${name}/apply`, { method: "POST" }).then((r) =>
      json<{ ok: boolean; conversation: ConversationMeta }>(r),
    ),

  // ── Providers (process-global) ──────────────────────────────────────────

  providers: () =>
    fetch(`${API_BASE}/api/providers`).then((r) =>
      json<{ providers: ProviderInfo[]; explicitlyEnabled: string[] }>(r),
    ),

  addProvider: (name: string, key: string) =>
    fetch(`${API_BASE}/api/providers/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    }).then((r) =>
      json<{ name: string; configured: boolean; source?: string; label?: string }>(r),
    ),

  removeProvider: (name: string) =>
    fetch(`${API_BASE}/api/providers/${name}`, { method: "DELETE" }).then((r) =>
      json<{ name: string; configured: boolean; agentsUsing?: string[] }>(r),
    ),

  loginProvider: (name: string) =>
    fetch(`${API_BASE}/api/providers/${name}/login`, { method: "POST" }).then((r) =>
      json<{ accepted: boolean; provider: string }>(r),
    ),

  // ── Room CRUD (process-global) ──────────────────────────────────────────

  listRooms: () =>
    fetch(`${API_BASE}/api/rooms`).then((r) => json<RoomSummary[]>(r)),

  createRoom: (body: { name: string; roomId?: string; preset?: string; goal?: string }) =>
    fetch(`${API_BASE}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<RoomSummary>(r)),

  getRoomDetails: (roomId: string) =>
    fetch(`${API_BASE}/api/rooms/${roomId}`).then((r) => json<RoomSummary>(r)),

  destroyRoom: (roomId: string) =>
    fetch(`${API_BASE}/api/rooms/${roomId}`, { method: "DELETE" }).then((r) => {
      if (!r.ok && r.status !== 204) throw new Error(`${r.status}`)
    }),

  renameRoom: (roomId: string, name: string) =>
    fetch(`${API_BASE}/api/rooms/${roomId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((r) => {
      if (!r.ok) throw new Error(`${r.status}`)
      return json<{ roomId: string; name: string }>(r)
    }),
}
