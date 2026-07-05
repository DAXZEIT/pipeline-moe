// Framework-agnostic room state + a pure SSE reducer.
//
// Every handler here was lifted verbatim from the web app's `useRoom` hook,
// which already wrote every update as a functional `setX(prev => next)` — i.e.
// each was already a pure function of (prevState, eventData). That made the
// transposition mechanical: this file holds exactly the same transitions with
// no React, no fetch, no timers.
//
// Notices are the one transition that isn't pure state→state (they auto-expire
// on a timer), so the reducer surfaces them as `effects` for the store to
// apply, rather than mutating a notice list here.

import type {
  ConversationMeta,
  Message,
  OAuthProgress,
  ProviderInfo,
  Receipt,
  RosterItem,
  RouteProposal,
  RoutingMode,
  ToolActivity,
  WorkspaceFile,
} from "./types.js"

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"

/** A transient toast. `id` is assigned by the store, not the reducer. */
export interface Notice {
  id: number
  msg: string
  level: "info" | "error"
}

/** The complete observable state of one room. */
export interface RoomState {
  roster: RosterItem[]
  messages: Message[]
  /** In-flight text deltas, keyed by agent id (cleared when the message lands). */
  streaming: Record<string, string>
  /** In-flight tool calls of running agents, keyed by agent id. */
  liveActivity: Record<string, ToolActivity[]>
  /** In-flight reasoning deltas, keyed by agent id. */
  liveReasoning: Record<string, string>
  /** Filesystem receipts, keyed by the transcript index of the owning message. */
  receipts: Record<number, Receipt>
  workspace: WorkspaceFile[]
  notices: Notice[]
  connected: boolean
  turnActive: boolean
  runningAgentId: string | null
  paused: boolean
  pausedQuestion: string | null
  pausedAskerId: string | null
  chaining: boolean
  routingMode: RoutingMode
  defaultAgent: string | null
  fallbackAgent: string | null
  maxChainHops: number
  circuitBreaker: boolean
  defaultThinkingLevel: ThinkingLevel
  allowCloud: boolean
  compactionReserveTokens: number
  pendingRoute: RouteProposal[] | null
  maxRooms: number
  conversations: ConversationMeta[]
  currentConversationId: string
  providers: ProviderInfo[]
  explicitlyEnabled: string[]
  /** In-flight OAuth login flow, or null. Persists until success/error/dismiss. */
  oauthProgress: OAuthProgress | null
}

/** The initial state of a freshly-opened room, before any snapshot or SSE. */
export const initialRoomState: RoomState = {
  roster: [],
  messages: [],
  streaming: {},
  liveActivity: {},
  liveReasoning: {},
  receipts: {},
  workspace: [],
  notices: [],
  connected: false,
  turnActive: false,
  runningAgentId: null,
  paused: false,
  pausedQuestion: null,
  pausedAskerId: null,
  chaining: true,
  routingMode: "auto",
  defaultAgent: null,
  fallbackAgent: null,
  maxChainHops: 30,
  circuitBreaker: true,
  defaultThinkingLevel: "medium",
  allowCloud: false,
  compactionReserveTokens: 38000,
  pendingRoute: null,
  maxRooms: 8,
  conversations: [],
  currentConversationId: "",
  providers: [],
  explicitlyEnabled: [],
  oauthProgress: null,
}

/**
 * Reset the per-turn transient fields. These are driven only by
 * `turn`/`token`/`activity` SSE events; on a room/conversation switch they must
 * be cleared, otherwise a turn the new context never started would leave them
 * pinned (e.g. a stuck "agents running…" or a stale ask_user prompt).
 */
export function resetTransient(state: RoomState): RoomState {
  return {
    ...state,
    turnActive: false,
    runningAgentId: null,
    paused: false,
    pausedQuestion: null,
    pausedAskerId: null,
    pendingRoute: null,
    streaming: {},
    liveActivity: {},
    liveReasoning: {},
    receipts: {},
  }
}

/** The named SSE events a room client subscribes to. */
export const SSE_EVENT_NAMES = [
  "roster",
  "status",
  "token",
  "activity",
  "reasoning",
  "message",
  "receipt",
  "workspace",
  "notice",
  "turn",
  "settings",
  "routing",
  "transcript",
  "conversations",
  "providers",
  "oauth_progress",
] as const

export type SseEventName = (typeof SSE_EVENT_NAMES)[number]

/** A parsed SSE event: its name plus the JSON-decoded payload. */
export interface SseEvent {
  name: SseEventName
  data: unknown
}

/** A side effect the store must apply (currently only transient notices). */
export type Effect = { type: "notice"; msg: string; level: "info" | "error" }

export interface ReduceResult {
  state: RoomState
  effects: Effect[]
}

const noEffects = (state: RoomState): ReduceResult => ({ state, effects: [] })

function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map
  const next = { ...map }
  delete next[key]
  return next
}

/**
 * The pure SSE reducer. Given the current state and one parsed event, returns
 * the next state plus any notices to surface. Never mutates its inputs.
 */
export function reduce(state: RoomState, event: SseEvent): ReduceResult {
  switch (event.name) {
    case "roster":
      return noEffects({ ...state, roster: event.data as RosterItem[] })

    case "status": {
      const data = event.data as {
        id: string
        status: RosterItem["status"]
        contextUsage?: RosterItem["contextUsage"]
        sessionStats?: RosterItem["sessionStats"]
        retry?: RosterItem["retry"]
      }
      return noEffects({
        ...state,
        roster: state.roster.map((p) => {
          if (p.id !== data.id) return p
          const base: RosterItem = { ...p, status: data.status }
          // Only update contextUsage when the payload explicitly carries it.
          // Mid-turn status events (e.g. "working") don't include it — preserving
          // the last known value prevents the progress bar from briefly clearing.
          if (data.contextUsage !== undefined) base.contextUsage = data.contextUsage
          if (data.sessionStats !== undefined) base.sessionStats = data.sessionStats
          if (data.retry !== undefined) base.retry = data.retry
          return base
        }),
      })
    }

    case "token": {
      const { id, delta } = event.data as { id: string; delta: string }
      return noEffects({ ...state, streaming: { ...state.streaming, [id]: (state.streaming[id] ?? "") + delta } })
    }

    case "activity": {
      const { id, item } = event.data as { id: string; item: ToolActivity }
      const list = state.liveActivity[id] ?? []
      const idx = list.findIndex((x) => x.toolCallId === item.toolCallId)
      const next = idx >= 0 ? list.map((x, i) => (i === idx ? item : x)) : [...list, item]
      return noEffects({ ...state, liveActivity: { ...state.liveActivity, [id]: next } })
    }

    case "reasoning": {
      const { id, delta } = event.data as { id: string; delta: string }
      return noEffects({ ...state, liveReasoning: { ...state.liveReasoning, [id]: (state.liveReasoning[id] ?? "") + delta } })
    }

    case "message": {
      const msg = event.data as Message
      const messages = [...state.messages, msg]
      if (msg.author === "user") return noEffects({ ...state, messages })
      // The message now carries its final activity; drop the live buffers.
      return noEffects({
        ...state,
        messages,
        streaming: omit(state.streaming, msg.author),
        liveActivity: omit(state.liveActivity, msg.author),
        liveReasoning: omit(state.liveReasoning, msg.author),
      })
    }

    case "receipt": {
      const r = event.data as Receipt
      const last = [...state.messages].reverse().find((m) => m.author === r.participantId)
      if (!last) return noEffects(state)
      return noEffects({ ...state, receipts: { ...state.receipts, [last.index]: r } })
    }

    case "workspace":
      return noEffects({ ...state, workspace: event.data as WorkspaceFile[] })

    case "notice": {
      const { msg, level } = event.data as { msg: string; level?: "info" | "error" }
      return { state, effects: [{ type: "notice", msg, level: level ?? "info" }] }
    }

    case "turn": {
      const data = event.data as {
        phase: "start" | "end" | "pause" | "resume" | "chain"
        agentId?: string
        question?: string
        askerId?: string
        from?: string
        targets?: string[]
      }
      if (data.phase === "start") {
        return noEffects({
          ...state,
          turnActive: true,
          runningAgentId: data.agentId ?? null,
          streaming: {},
          liveActivity: {},
          liveReasoning: {},
        })
      }
      if (data.phase === "end") {
        return noEffects({
          ...state,
          turnActive: false,
          runningAgentId: null,
          paused: false,
          pausedQuestion: null,
          pausedAskerId: null,
          pendingRoute: null,
        })
      }
      if (data.phase === "pause") {
        return {
          state: {
            ...state,
            turnActive: false,
            paused: true,
            pausedQuestion: data.question ?? null,
            pausedAskerId: data.askerId ?? null,
          },
          effects: [{ type: "notice", msg: `${data.askerId} is waiting for your answer.`, level: "info" }],
        }
      }
      if (data.phase === "resume") {
        return {
          state: {
            ...state,
            paused: false,
            pausedQuestion: null,
            pausedAskerId: null,
            turnActive: true,
          },
          effects: [{ type: "notice", msg: `Resuming — answering ${data.askerId}`, level: "info" }],
        }
      }
      // chain
      const to = (data.targets ?? []).map((t) => `@${t}`).join(" ")
      return { state, effects: [{ type: "notice", msg: `@${data.from} → ${to}`, level: "info" }] }
    }

    case "settings": {
      const d = event.data as {
        chaining: boolean
        routingMode?: RoutingMode
        defaultAgent?: string | null
        fallbackAgent?: string | null
        maxChainHops?: number
        circuitBreaker?: boolean
        defaultThinkingLevel?: ThinkingLevel
        allowCloud?: boolean
        compactionReserveTokens?: number
      }
      const next: RoomState = { ...state, chaining: d.chaining }
      if (d.routingMode !== undefined) next.routingMode = d.routingMode
      if (d.defaultAgent !== undefined) next.defaultAgent = d.defaultAgent
      if (d.fallbackAgent !== undefined) next.fallbackAgent = d.fallbackAgent
      if (d.maxChainHops !== undefined) next.maxChainHops = d.maxChainHops
      if (d.circuitBreaker !== undefined) next.circuitBreaker = d.circuitBreaker
      if (d.defaultThinkingLevel !== undefined) next.defaultThinkingLevel = d.defaultThinkingLevel
      if (d.allowCloud !== undefined) next.allowCloud = d.allowCloud
      if (d.compactionReserveTokens !== undefined) next.compactionReserveTokens = d.compactionReserveTokens
      return noEffects(next)
    }

    case "routing": {
      const data = event.data as { type: "proposed" | "resolved"; proposals?: RouteProposal[] }
      if (data.type === "proposed") {
        // paused for approval — not actively running
        return noEffects({ ...state, pendingRoute: data.proposals ?? [], turnActive: false })
      }
      return noEffects({ ...state, pendingRoute: null })
    }

    case "transcript": {
      const msgs = event.data as Message[]
      return noEffects({
        ...state,
        messages: msgs,
        streaming: {},
        liveActivity: {},
        liveReasoning: {},
        receipts: {},
      })
    }

    case "conversations": {
      const { currentId, list } = event.data as { currentId: string; list: ConversationMeta[] }
      return noEffects({ ...state, conversations: list, currentConversationId: currentId })
    }

    case "providers": {
      const data = event.data as { providers?: ProviderInfo[]; explicitlyEnabled?: string[] }
      const next: RoomState = { ...state }
      if (data.providers) next.providers = data.providers
      if (data.explicitlyEnabled) next.explicitlyEnabled = data.explicitlyEnabled
      return noEffects(next)
    }

    case "oauth_progress": {
      const data = event.data as {
        type: "device_code" | "auth_url" | "progress" | "success" | "error"
        provider?: string
        verificationUri?: string
        userCode?: string
        url?: string
        instructions?: string
        message?: string
      }
      let effect: Effect
      if (data.type === "device_code") {
        effect = { type: "notice", msg: `OAuth for ${data.provider}: visit ${data.verificationUri}, enter code ${data.userCode}`, level: "info" }
      } else if (data.type === "auth_url") {
        effect = { type: "notice", msg: `OAuth for ${data.provider}: ${data.instructions || "visit " + data.url}`, level: "info" }
      } else if (data.type === "progress") {
        effect = { type: "notice", msg: `OAuth ${data.provider}: ${data.message}`, level: "info" }
      } else if (data.type === "success") {
        effect = { type: "notice", msg: data.message ?? "", level: "info" }
      } else {
        effect = { type: "notice", msg: data.message ?? "", level: "error" }
      }
      const oauthProgress: OAuthProgress = {
        provider: data.provider ?? state.oauthProgress?.provider ?? "",
        status: data.type,
        verificationUri: data.verificationUri,
        userCode: data.userCode,
        url: data.url,
        instructions: data.instructions,
        message: data.message,
      }
      return { state: { ...state, oauthProgress }, effects: [effect] }
    }

    default:
      return noEffects(state)
  }
}
