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
  RoomTask,
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
  /** Epoch ms when the current agent started running (client-side clock, set
   *  per agent across a chained drain) — drives live elapsed counters. Null
   *  when nothing runs; the authoritative per-turn duration is the message's
   *  durationMs. */
  runningSince: number | null
  /** True while the agent's most recent delta was reasoning — i.e. it is
   *  thinking RIGHT NOW, not merely has a reasoning trace this turn. Lets
   *  clients re-show "thinking…" on a second burst after text/tools. */
  reasoningActive: Record<string, boolean>
  paused: boolean
  pausedQuestion: string | null
  pausedAskerId: string | null
  /** Closed answer choices for the paused question (ask_user options), if any. */
  pausedOptions: string[] | null
  chaining: boolean
  routingMode: RoutingMode
  defaultAgent: string | null
  fallbackAgent: string | null
  maxChainHops: number
  defaultThinkingLevel: ThinkingLevel
  allowCloud: boolean
  compactionReserveTokens: number
  /** "provider/id" the room's default-model agents actually run on, or null
   *  when the server relies on pi's own resolution (or predates the field). */
  defaultModel: string | null
  pendingRoute: RouteProposal[] | null
  maxRooms: number
  conversations: ConversationMeta[]
  currentConversationId: string
  providers: ProviderInfo[]
  explicitlyEnabled: string[]
  /** In-flight OAuth login flow, or null. Persists until success/error/dismiss. */
  oauthProgress: OAuthProgress | null
  /** Shared task board — the agents' live decomposition of the current work. */
  tasks: RoomTask[]
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
  runningSince: null,
  reasoningActive: {},
  paused: false,
  pausedQuestion: null,
  pausedAskerId: null,
  pausedOptions: null,
  chaining: true,
  routingMode: "auto",
  defaultAgent: null,
  fallbackAgent: null,
  maxChainHops: 30,
  defaultThinkingLevel: "medium",
  allowCloud: false,
  compactionReserveTokens: 38000,
  defaultModel: null,
  pendingRoute: null,
  maxRooms: 8,
  conversations: [],
  currentConversationId: "",
  providers: [],
  explicitlyEnabled: [],
  oauthProgress: null,
  tasks: [],
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
    runningSince: null,
    paused: false,
    pausedQuestion: null,
    pausedAskerId: null,
    pausedOptions: null,
    pendingRoute: null,
    streaming: {},
    liveActivity: {},
    liveReasoning: {},
    reasoningActive: {},
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
  "tasks",
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
      return noEffects({
        ...state,
        streaming: { ...state.streaming, [id]: (state.streaming[id] ?? "") + delta },
        // A text delta means the thinking burst (if any) just ended.
        ...(state.reasoningActive[id] ? { reasoningActive: { ...state.reasoningActive, [id]: false } } : {}),
      })
    }

    case "activity": {
      const { id, item } = event.data as { id: string; item: ToolActivity }
      const list = state.liveActivity[id] ?? []
      const idx = list.findIndex((x) => x.toolCallId === item.toolCallId)
      const next = idx >= 0 ? list.map((x, i) => (i === idx ? item : x)) : [...list, item]
      return noEffects({
        ...state,
        liveActivity: { ...state.liveActivity, [id]: next },
        // Executing a tool means the agent stopped thinking for now.
        ...(state.reasoningActive[id] ? { reasoningActive: { ...state.reasoningActive, [id]: false } } : {}),
      })
    }

    case "reasoning": {
      const { id, delta } = event.data as { id: string; delta: string }
      return noEffects({
        ...state,
        liveReasoning: { ...state.liveReasoning, [id]: (state.liveReasoning[id] ?? "") + delta },
        ...(state.reasoningActive[id] ? {} : { reasoningActive: { ...state.reasoningActive, [id]: true } }),
      })
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
        reasoningActive: omit(state.reasoningActive, msg.author),
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
        phase: "start" | "end" | "pause" | "resume" | "chain" | "agent" | "parallel"
        agentId?: string
        question?: string
        /** Closed answer choices carried with a pause (ask_user options). */
        options?: string[]
        askerId?: string
        from?: string
        targets?: string[]
      }
      // Emitted whenever an agent actually starts generating — this is what
      // keeps runningAgentId truthful across a chained drain (turn start only
      // carries the FIRST agent of the turn).
      if (data.phase === "agent") {
        // Each agent of a chained drain restarts the clock — the elapsed
        // counter reads per-agent, matching the per-message durationMs.
        return noEffects({ ...state, turnActive: true, runningAgentId: data.agentId ?? null, runningSince: Date.now() })
      }
      if (data.phase === "start") {
        return noEffects({
          ...state,
          turnActive: true,
          runningAgentId: data.agentId ?? null,
          runningSince: Date.now(),
          streaming: {},
          liveActivity: {},
          liveReasoning: {},
          reasoningActive: {},
        })
      }
      if (data.phase === "end") {
        return noEffects({
          ...state,
          turnActive: false,
          runningAgentId: null,
          runningSince: null,
          paused: false,
          pausedQuestion: null,
          pausedAskerId: null,
          pausedOptions: null,
          pendingRoute: null,
        })
      }
      if (data.phase === "pause") {
        return {
          state: {
            ...state,
            turnActive: false,
            runningSince: null,
            paused: true,
            pausedQuestion: data.question ?? null,
            pausedAskerId: data.askerId ?? null,
            pausedOptions: data.options?.length ? data.options : null,
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
            pausedOptions: null,
            turnActive: true,
          },
          effects: [{ type: "notice", msg: `Resuming — answering ${data.askerId}`, level: "info" }],
        }
      }
      if (data.phase === "chain") {
        const to = (data.targets ?? []).map((t) => `@${t}`).join(" ")
        const msg = data.from ? `@${data.from} → ${to}` : `→ ${to}`
        return { state, effects: [{ type: "notice", msg, level: "info" }] }
      }
      // Unknown/parallel phases: no state change, no notice. "parallel" already
      // arrives as a server-side notice; anything newer must not break old clients.
      return noEffects(state)
    }

    case "settings": {
      const d = event.data as {
        chaining: boolean
        routingMode?: RoutingMode
        defaultAgent?: string | null
        fallbackAgent?: string | null
        maxChainHops?: number
        defaultThinkingLevel?: ThinkingLevel
        allowCloud?: boolean
        compactionReserveTokens?: number
        defaultModel?: string | null
      }
      const next: RoomState = { ...state, chaining: d.chaining }
      if (d.routingMode !== undefined) next.routingMode = d.routingMode
      if (d.defaultAgent !== undefined) next.defaultAgent = d.defaultAgent
      if (d.fallbackAgent !== undefined) next.fallbackAgent = d.fallbackAgent
      if (d.maxChainHops !== undefined) next.maxChainHops = d.maxChainHops
      if (d.defaultThinkingLevel !== undefined) next.defaultThinkingLevel = d.defaultThinkingLevel
      if (d.allowCloud !== undefined) next.allowCloud = d.allowCloud
      if (d.compactionReserveTokens !== undefined) next.compactionReserveTokens = d.compactionReserveTokens
      if (d.defaultModel !== undefined) next.defaultModel = d.defaultModel
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

    case "tasks": {
      const data = event.data as { tasks?: RoomTask[] }
      return noEffects({ ...state, tasks: data.tasks ?? [] })
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
        type: "device_code" | "auth_url" | "prompt" | "progress" | "success" | "error"
        provider?: string
        verificationUri?: string
        userCode?: string
        url?: string
        instructions?: string
        message?: string
        placeholder?: string
      }
      let effect: Effect
      if (data.type === "device_code") {
        effect = { type: "notice", msg: `OAuth for ${data.provider}: visit ${data.verificationUri}, enter code ${data.userCode}`, level: "info" }
      } else if (data.type === "auth_url") {
        effect = { type: "notice", msg: `OAuth for ${data.provider}: ${data.instructions || "visit " + data.url}`, level: "info" }
      } else if (data.type === "prompt") {
        effect = { type: "notice", msg: `OAuth ${data.provider}: ${data.message ?? "input required"}`, level: "info" }
      } else if (data.type === "progress") {
        effect = { type: "notice", msg: `OAuth ${data.provider}: ${data.message}`, level: "info" }
      } else if (data.type === "success") {
        effect = { type: "notice", msg: data.message ?? "", level: "info" }
      } else {
        effect = { type: "notice", msg: data.message ?? "", level: "error" }
      }
      // Carry link details across steps: a later "prompt"/"progress" event must
      // not wipe the auth URL the user may still need on screen.
      const prev = state.oauthProgress
      const oauthProgress: OAuthProgress = {
        provider: data.provider ?? prev?.provider ?? "",
        status: data.type,
        verificationUri: data.verificationUri ?? prev?.verificationUri,
        userCode: data.userCode ?? prev?.userCode,
        url: data.url ?? prev?.url,
        instructions: data.instructions ?? prev?.instructions,
        message: data.message,
        placeholder: data.placeholder ?? prev?.placeholder,
      }
      return { state: { ...state, oauthProgress }, effects: [effect] }
    }

    default:
      return noEffects(state)
  }
}
