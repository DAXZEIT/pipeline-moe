// The room store: the single effectful owner of a room's live state.
//
// It wraps the pure reducer (state.ts) with everything that isn't pure — the
// initial REST snapshot, the SSE subscription, notice expiry timers, and the
// action methods that POST/PATCH/DELETE and map failures to notices. It is
// framework-agnostic: it exposes a `subscribe`/`getSnapshot` contract that a
// React `useSyncExternalStore` adapter or an Ink render loop can both consume.

import { createApi } from "./api.js"
import type { RoomApi } from "./api.js"
import {
  initialRoomState,
  reduce,
  resetTransient,
  SSE_EVENT_NAMES,
  type Effect,
  type RoomState,
  type SseEventName,
  type ThinkingLevel,
} from "./state.js"
import type { RouteDecision, RoutingMode } from "./types.js"

// ── SSE transport abstraction ───────────────────────────────────────────────
// The store doesn't know how events arrive — the host injects a factory. The
// browser uses the global EventSource; a Node client would pass an `eventsource`
// shim with the same shape. This is the seam that keeps the store host-neutral.

export interface SseConnection {
  close(): void
}

export interface SseHandlers {
  onOpen(): void
  onError(): void
  onEvent(name: SseEventName, data: string): void
}

export type EventSourceFactory = (url: string, handlers: SseHandlers) => SseConnection

/** EventSource factory backed by the browser's global `EventSource`. */
export const browserEventSourceFactory: EventSourceFactory = (url, h) => {
  const es = new EventSource(url)
  es.onopen = () => h.onOpen()
  es.onerror = () => h.onError()
  for (const name of SSE_EVENT_NAMES) {
    es.addEventListener(name, (e) => h.onEvent(name, (e as MessageEvent).data))
  }
  return { close: () => es.close() }
}

export interface RoomStoreOptions {
  /** Server origin, e.g. "http://localhost:5300". */
  apiBase: string
  /** Room to subscribe to. Defaults to "default". */
  roomId?: string
  /** How events arrive. Defaults to the browser EventSource factory. */
  eventSourceFactory?: EventSourceFactory
  /** Notice auto-dismiss delay in ms. Defaults to 5000. */
  noticeTtlMs?: number
}

export type RoomStore = ReturnType<typeof createRoomStore>

/**
 * Create a room store bound to a server and room. Call {@link RoomStore.start}
 * to load the snapshot and open the SSE stream, and {@link RoomStore.stop} to
 * tear it down. Read state via `getSnapshot()` and react to changes via
 * `subscribe()`.
 */
export function createRoomStore(opts: RoomStoreOptions) {
  const roomId = opts.roomId || "default"
  const noticeTtlMs = opts.noticeTtlMs ?? 5000
  const makeEventSource = opts.eventSourceFactory ?? browserEventSourceFactory

  // Route prefix: /api for the default room (backward compat), /api/rooms/:id
  // otherwise. SSE is always the room-scoped endpoint — even "default" — so the
  // default room doesn't inherit the unfiltered global stream.
  const prefix = roomId !== "default" ? `/api/rooms/${roomId}` : "/api"
  const { makeRoomApi, api } = createApi(opts.apiBase)
  const rApi: RoomApi = makeRoomApi(prefix)
  const sseUrl = `${opts.apiBase}/api/rooms/${roomId}/events`

  let state: RoomState = initialRoomState
  const listeners = new Set<() => void>()
  let noticeSeq = 1
  const noticeTimers = new Set<ReturnType<typeof setTimeout>>()
  let conn: SseConnection | null = null

  const getSnapshot = (): RoomState => state
  const subscribe = (cb: () => void): (() => void) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }
  const emit = () => {
    for (const cb of listeners) cb()
  }
  const set = (next: RoomState) => {
    if (next === state) return
    state = next
    emit()
  }
  /** Merge a partial into state (used by actions doing optimistic / response writes). */
  const patch = (partial: Partial<RoomState>) => set({ ...state, ...partial })

  const pushNotice = (msg: string, level: "info" | "error" = "info") => {
    const id = noticeSeq++
    set({ ...state, notices: [...state.notices, { id, msg, level }] })
    const timer = setTimeout(() => {
      noticeTimers.delete(timer)
      set({ ...state, notices: state.notices.filter((n) => n.id !== id) })
    }, noticeTtlMs)
    noticeTimers.add(timer)
  }

  const applyEffects = (effects: Effect[]) => {
    for (const e of effects) pushNotice(e.msg, e.level)
  }

  const onEvent = (name: SseEventName, raw: string) => {
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      return
    }
    const result = reduce(state, { name, data })
    set(result.state)
    applyEffects(result.effects)
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Fetch the full REST snapshot. Runs at start() and again on every SSE open:
   * if the client came up before the server (or the server restarted), the
   * initial fetches failed silently — re-running them on (re)connect is what
   * lets providers/settings/conversations self-heal instead of staying empty.
   */
  const loadSnapshot = () => {
    rApi.transcript().then((m) => patch({ messages: m })).catch(() => {})
    rApi.workspace().then((w) => patch({ workspace: w })).catch(() => {})
    rApi.roster().then((r) => patch({ roster: r })).catch(() => {})
    rApi.settings().then((s) => {
      const next: Partial<RoomState> = {
        chaining: s.chaining,
        routingMode: s.routingMode,
        defaultAgent: s.defaultAgent,
      }
      if (s.fallbackAgent !== undefined) next.fallbackAgent = s.fallbackAgent
      if (s.maxChainHops !== undefined) next.maxChainHops = s.maxChainHops
      if (s.circuitBreaker !== undefined) next.circuitBreaker = s.circuitBreaker
      if (s.defaultThinkingLevel !== undefined) next.defaultThinkingLevel = s.defaultThinkingLevel
      if (s.allowCloud !== undefined) next.allowCloud = s.allowCloud
      if (s.compactionReserveTokens !== undefined) next.compactionReserveTokens = s.compactionReserveTokens
      if (s.maxRooms !== undefined) next.maxRooms = s.maxRooms
      next.pendingRoute = s.pendingRoute ? s.pendingRoute.proposals : null
      patch(next)
    }).catch(() => {})
    rApi.conversations().then((c) => patch({ conversations: c.list, currentConversationId: c.currentId })).catch(() => {})
    api.providers().then((d) => patch({ providers: d.providers, explicitlyEnabled: d.explicitlyEnabled })).catch(() => {})
  }

  /** Load the REST snapshot and open the SSE stream. Idempotent-safe to call once. */
  const start = () => {
    // Clear transient fields before (re)loading — a reused store must not show a
    // prior room's in-flight turn. Fresh stores are already clean; this is cheap.
    set(resetTransient(state))
    loadSnapshot()

    conn = makeEventSource(sseUrl, {
      onOpen: () => {
        patch({ connected: true })
        loadSnapshot()
      },
      onError: () => patch({ connected: false }),
      onEvent,
    })
  }

  /** Close the SSE stream and cancel pending notice timers. */
  const stop = () => {
    conn?.close()
    conn = null
    for (const t of noticeTimers) clearTimeout(t)
    noticeTimers.clear()
  }

  const fail = (err: unknown) => pushNotice(String((err as Error)?.message ?? err), "error")

  // ── Actions ───────────────────────────────────────────────────────────────
  // Thin wrappers over the REST surface. Optimistic writes and response-driven
  // state updates are preserved exactly as the web hook had them.

  const actions = {
    send: (text: string, images?: string[]) => {
      rApi.sendMessage(text, images).catch(fail)
    },

    setActive: (id: string, active: boolean) => {
      rApi.setActive(id, active).catch(fail)
    },

    setParallel: (id: string, parallel: boolean) => {
      rApi.setParallel(id, parallel).catch(fail)
    },

    kick: (id: string) => {
      rApi.kick(id).catch(fail)
    },

    createParticipant: (body: Parameters<RoomApi["create"]>[0]) =>
      rApi.create(body).catch((err) => {
        fail(err)
        throw err
      }),

    addFromTemplate: (templateId: string) =>
      rApi.addFromTemplate(templateId).catch((err) => {
        fail(err)
        throw err
      }),

    savePreset: (name: string) =>
      rApi.savePreset(name).catch((err) => {
        fail(err)
        throw err
      }),

    loadPreset: (name: string) =>
      rApi.loadPreset(name).catch((err) => {
        fail(err)
        throw err
      }),

    applyPreset: (name: string) =>
      rApi.applyPreset(name).catch((err) => {
        fail(err)
        throw err
      }),

    getParticipant: (id: string) => rApi.participant(id),

    updateParticipant: (id: string, patchBody: Parameters<RoomApi["updateAgent"]>[1]) =>
      rApi.updateAgent(id, patchBody).catch((err) => {
        fail(err)
        throw err
      }),

    reorderParticipants: (order: string[]) => {
      // Optimistic: reorder the local roster immediately so the drag feels
      // instant; the server's "roster" broadcast then confirms it.
      const byId = new Map(state.roster.map((p) => [p.id, p]))
      const reordered = order.map((id) => byId.get(id)).filter(Boolean) as RoomState["roster"]
      for (const p of state.roster) if (!order.includes(p.id)) reordered.push(p)
      patch({ roster: reordered })
      rApi.reorder(order).catch((err) => {
        fail(err)
        rApi.roster().then((r) => patch({ roster: r })).catch(() => {}) // revert to server truth
      })
    },

    abort: () => {
      rApi.abort().catch(() => {})
    },

    steer: (text: string, target: string) => {
      rApi.steerMessage(text, target).catch((err) => {
        const msg = String((err as Error)?.message ?? err)
        if (msg.includes("not running") || msg.includes("cannot steer")) {
          pushNotice(`@${target} is not running — cannot steer`, "error")
        } else {
          pushNotice(msg, "error")
        }
      })
    },

    compactAgent: (id: string) => {
      pushNotice(`Compacting @${id}…`)
      rApi.compact(id)
        .then((r) => pushNotice(`@${id} compacted: ${r.tokensBefore} tokens before → summary generated.`))
        .catch(fail)
    },

    setChaining: (value: boolean) => {
      rApi.setChaining(value).then((s) => patch({ chaining: s.chaining })).catch(fail)
    },

    setRoutingMode: (mode: RoutingMode) => {
      rApi.setRoutingMode(mode).then((s) => patch({ routingMode: s.routingMode })).catch(fail)
    },

    setCircuitBreaker: (value: boolean) => {
      rApi.setCircuitBreaker(value).then((s) => patch({ circuitBreaker: s.circuitBreaker })).catch(fail)
    },

    setDefaultThinkingLevel: (level: ThinkingLevel) => {
      rApi.setDefaultThinkingLevel(level).then((s) => patch({ defaultThinkingLevel: s.defaultThinkingLevel })).catch(fail)
    },

    setAllowCloud: (value: boolean) => {
      rApi.setAllowCloud(value).then((s) => patch({ allowCloud: s.allowCloud })).catch(fail)
    },

    setCompactionReserveTokens: (value: number) => {
      rApi.setCompactionReserveTokens(value).then((s) => patch({ compactionReserveTokens: s.compactionReserveTokens })).catch(fail)
    },

    resolveRoute: (decision: RouteDecision) => {
      patch({ pendingRoute: null }) // optimistic — the card disappears immediately
      rApi.resolveRoute(decision).catch(fail)
    },

    setDefaultAgent: (id: string | null) => {
      rApi.setDefaultAgent(id).then((s) => patch({ defaultAgent: s.defaultAgent })).catch(fail)
    },

    setFallbackAgent: (id: string | null) => {
      rApi.setFallbackAgent(id).then((s) => patch({ fallbackAgent: s.fallbackAgent ?? null })).catch(fail)
    },

    setMaxChainHops: (n: number) => {
      rApi.setMaxChainHops(n).then((s) => patch({ maxChainHops: s.maxChainHops })).catch(fail)
    },

    newConversation: (title?: string) => {
      rApi.newConversation(title).catch(fail)
    },

    loadConversation: (id: string) => {
      if (id === state.currentConversationId) return
      rApi.loadConversation(id).catch(fail)
    },

    renameConversation: (id: string, title: string) => {
      rApi.renameConversation(id, title).catch(fail)
    },

    deleteConversation: (id: string) => {
      rApi.deleteConversation(id).catch(fail)
    },

    addProvider: (name: string, key: string) => {
      api.addProvider(name, key).then(() => {
        pushNotice(`Provider "${name}" configured.`)
        // Refresh models so the dropdown picks up new models.
        api.models().catch(() => {})
      }).catch(fail)
    },

    removeProvider: (name: string) => {
      api.removeProvider(name).then((r) => {
        let msg = `Provider "${name}" removed.`
        if (r.agentsUsing && r.agentsUsing.length > 0) {
          msg += ` Note: ${r.agentsUsing.join(", ")} may need model reassigned.`
        }
        pushNotice(msg)
      }).catch(fail)
    },

    loginProvider: (name: string) => {
      api.loginProvider(name).then(() => {
        pushNotice(`OAuth login started for ${name} — follow the instructions in notifications.`)
      }).catch(fail)
    },

    dismissOAuth: () => {
      patch({ oauthProgress: null })
    },
  }

  return { roomId, getSnapshot, subscribe, start, stop, actions, pushNotice }
}
