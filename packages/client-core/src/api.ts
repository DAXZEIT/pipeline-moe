import type {
  ConversationMeta,
  Message,
  ModelInfo,
  PersonaDetail,
  PersonaTemplate,
  PresetFile,
  ProviderInfo,
  ResumableRoom,
  RoomSettings,
  RoomSummary,
  RouteDecision,
  RoutingMode,
  RosterItem,
  WorkspaceFile,
} from "./types.js"

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = ""
    try {
      const body = (await res.json()) as { error?: string }
      detail = body.error ?? ""
    } catch {
      /* ignore */
    }
    throw new Error(detail || `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

/**
 * Build the API surface bound to a given server base URL.
 *
 * This is the single place the client talks HTTP to a pipeline-moe server.
 * It is framework- and host-agnostic: the base URL is injected rather than
 * read from `import.meta.env`, so the same module serves the web frontend
 * (passing `import.meta.env.VITE_API_BASE`) and a terminal client (passing
 * `process.env`). `fetch`/`Response` are assumed to exist in the host (browser,
 * or Node ≥18).
 *
 * @param API_BASE  Server origin, e.g. "http://localhost:5300".
 * @returns `{ API_BASE, makeRoomApi, api }` — the same shape the web app
 *          previously imported from its local `api.ts`.
 */
export function createApi(API_BASE: string) {
  /**
   * Create a room-scoped API object for the given route prefix.
   * Use prefix "/api" for the default room (backward compat).
   * Use "/api/rooms/:roomId" for non-default rooms.
   */
  function makeRoomApi(prefix: string) {
    const base = `${API_BASE}${prefix}`
    return {
      roster: () => fetch(`${base}/participants`).then((r) => json<RosterItem[]>(r)),

      // Preset save/load/apply target THIS room (the prefix), so loading from the
      // second room's view doesn't clobber the default room.
      savePreset: (name: string) =>
        fetch(`${base}/presets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        }).then((r) => json<PresetFile>(r)),

      loadPreset: (name: string) =>
        fetch(`${base}/presets/${name}/load`, { method: "POST" }).then((r) =>
          json<{ ok: boolean; conversation: ConversationMeta; downgraded?: Array<{ agent: string; model: string }> }>(r),
        ),

      applyPreset: (name: string) =>
        fetch(`${base}/presets/${name}/apply`, { method: "POST" }).then((r) =>
          json<{ ok: boolean; conversation: ConversationMeta; downgraded?: Array<{ agent: string; model: string }> }>(r),
        ),
      transcript: () => fetch(`${base}/transcript`).then((r) => json<Message[]>(r)),
      workspace: () => fetch(`${base}/workspace`).then((r) => json<WorkspaceFile[]>(r)),

      sendMessage: (text: string, images?: string[]) =>
        fetch(`${base}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, ...(images && images.length > 0 ? { images } : {}) }),
        }).then((r) => json<{ accepted: boolean }>(r)),

      /** Run a shell command in this room's workspace; the command + output are
       *  posted to the shared transcript (author "shell") as context for all agents. */
      runShell: (command: string) =>
        fetch(`${base}/shell`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command }),
        }).then((r) => json<Message>(r)),

      /** Truncate this room's transcript to its first `keep` entries. The
       *  server rebuilds the sessions of agents that had already seen the
       *  removed messages. */
      rollback: (keep: number) =>
        fetch(`${base}/transcript/rollback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keep }),
        }).then((r) => json<{ ok: boolean; removed: number }>(r)),

      /** Post a shell command the client already ran interactively (TUI `!`
       *  mode) — no server-side execution, just the shared-context record. */
      postShellRecord: (command: string, output: string, exitCode: number | null) =>
        fetch(`${base}/shell/record`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command, output, exitCode }),
        }).then((r) => json<Message>(r)),

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

      addFromTemplate: (templateId: string) =>
        fetch(`${base}/participants/from-template`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ templateId }),
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
        fetch(`${base}/settings`).then((r) => json<RoomSettings>(r)),

      setChaining: (chaining: boolean) =>
        fetch(`${base}/settings`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chaining }),
        }).then((r) => json<RoomSettings>(r)),

      setDefaultAgent: (defaultAgent: string | null) =>
        fetch(`${base}/settings`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ defaultAgent }),
        }).then((r) => json<RoomSettings>(r)),

      setFallbackAgent: (fallbackAgent: string | null) =>
        fetch(`${base}/settings`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fallbackAgent }),
        }).then((r) => json<RoomSettings>(r)),

      setMaxChainHops: (maxChainHops: number) =>
        fetch(`${base}/settings`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ maxChainHops }),
        }).then((r) => json<RoomSettings>(r)),

      setRoutingMode: (routingMode: RoutingMode) =>
        fetch(`${base}/settings`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ routingMode }),
        }).then((r) => json<RoomSettings>(r)),

      setCircuitBreaker: (circuitBreaker: boolean) =>
        fetch(`${base}/settings`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ circuitBreaker }),
        }).then((r) => json<RoomSettings>(r)),

      setDefaultThinkingLevel: (defaultThinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh") =>
        fetch(`${base}/settings`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ defaultThinkingLevel }),
        }).then((r) => json<RoomSettings>(r)),

      setAllowCloud: (allowCloud: boolean) =>
        fetch(`${base}/settings`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ allowCloud }),
        }).then((r) => json<RoomSettings>(r)),

      setCompactionReserveTokens: (compactionReserveTokens: number) =>
        fetch(`${base}/settings`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ compactionReserveTokens }),
        }).then((r) => json<RoomSettings>(r)),

      resolveRoute: (decision: RouteDecision) =>
        fetch(`${base}/route`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(decision),
        }).then((r) => json(r)),

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

  const api = {
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

    deletePreset: (name: string) =>
      fetch(`${API_BASE}/api/presets/${name}`, { method: "DELETE" }).then((r) => {
        if (!r.ok && r.status !== 204) throw new Error(`${r.status}`)
      }),

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

    /** Answer an in-flight OAuth flow (pasted redirect URL / authorization code). */
    oauthInput: (name: string, value: string) =>
      fetch(`${API_BASE}/api/providers/${name}/login/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      }).then((r) => json<{ ok: boolean }>(r)),

    /** Cancel an in-flight OAuth flow (frees pi's localhost callback port). */
    cancelLogin: (name: string) =>
      fetch(`${API_BASE}/api/providers/${name}/login`, { method: "DELETE" }).then((r) =>
        json<{ ok: boolean }>(r),
      ),

    // ── Room CRUD (process-global) ──────────────────────────────────────────

    personaTemplates: () =>
      fetch(`${API_BASE}/api/persona-templates`).then((r) => json<PersonaTemplate[]>(r)),

    listRooms: () =>
      fetch(`${API_BASE}/api/rooms`).then((r) => json<RoomSummary[]>(r)),

    /** Fork a live room's discussion into a new room (same workspace, copied
     *  roster + transcript, fresh agent sessions). Returns the new room. */
    forkRoom: (roomId: string, name?: string) =>
      fetch(`${API_BASE}/api/rooms/${roomId}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(name ? { name } : {}),
      }).then((r) => json<RoomSummary>(r)),

    resumableRooms: () =>
      fetch(`${API_BASE}/api/rooms/resumable`).then((r) => json<ResumableRoom[]>(r)),

    resumeRoom: (roomId: string) =>
      fetch(`${API_BASE}/api/rooms/${roomId}/resume`, { method: "POST" }).then((r) =>
        json<RoomSummary>(r),
      ),

    /** Stop a specific room's in-flight pipeline (cancels a running goal). */
    abortRoom: (roomId: string) =>
      fetch(`${API_BASE}/api/rooms/${roomId}/abort`, { method: "POST" }).then((r) =>
        json<{ aborted: boolean }>(r),
      ),

    createRoom: (body: { name: string; roomId?: string; preset?: string; goal?: string; workspaceDir?: string }) =>
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

  return { API_BASE, makeRoomApi, api }
}

/** The shape returned by {@link createApi} — useful for typing consumers. */
export type ClientApi = ReturnType<typeof createApi>
/** The room-scoped API object (per-room operations). */
export type RoomApi = ReturnType<ClientApi["makeRoomApi"]>
/** The full API object (room-scoped default + process-global operations). */
export type Api = ClientApi["api"]
