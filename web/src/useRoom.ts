import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { makeRoomApi, api, API_BASE } from "./api"
import type {
  ConversationMeta,
  Message,
  Notice,
  ProviderInfo,
  Receipt,
  RosterItem,
  RouteDecision,
  RouteProposal,
  RoutingMode,
  ToolActivity,
  WorkspaceFile,
} from "./types"

let noticeSeq = 1

export function useRoom(roomId?: string) {
  // Route prefix: /api for the default room (backward compat), /api/rooms/:id for others.
  const prefix = roomId && roomId !== "default" ? `/api/rooms/${roomId}` : "/api"
  // Room-scoped API client. App never remounts on room switch (activeRoomId is
  // App's own state; the key={activeRoomId} lives on a child <main>, not on App),
  // so this must recompute when the prefix changes — otherwise every API call
  // would stay pinned to the first room's prefix while SSE alone tracks the switch.
  const rApi = useMemo(() => makeRoomApi(prefix), [prefix])
  // SSE must always be room-scoped — even the default room. /api/events is the
  // unfiltered global stream; subscribing the default room there leaks every
  // other room's roster/status events into it. The /api/rooms/:id/events route
  // resolves "default" too (the default room is registered under that id).
  const sseUrl = `${API_BASE}/api/rooms/${roomId || "default"}/events`
  const [roster, setRoster] = useState<RosterItem[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [streaming, setStreaming] = useState<Record<string, string>>({})
  // Tool calls of the currently-running agents, keyed by agent id (live only;
  // the final set is baked into each message once it lands).
  const [liveActivity, setLiveActivity] = useState<Record<string, ToolActivity[]>>({})
  const [liveReasoning, setLiveReasoning] = useState<Record<string, string>>({})
  const [receipts, setReceipts] = useState<Record<number, Receipt>>({})
  const [workspace, setWorkspace] = useState<WorkspaceFile[]>([])
  const [notices, setNotices] = useState<Notice[]>([])
  const [connected, setConnected] = useState(false)
  const [turnActive, setTurnActive] = useState(false)
  const [runningAgentId, setRunningAgentId] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [pausedQuestion, setPausedQuestion] = useState<string | null>(null)
  const [pausedAskerId, setPausedAskerId] = useState<string | null>(null)
  const [chaining, setChainingState] = useState(true)
  const [routingMode, setRoutingModeState] = useState<RoutingMode>("auto")
  const [defaultAgent, setDefaultAgentState] = useState<string | null>(null)
  const [fallbackAgent, setFallbackAgentState] = useState<string | null>(null)
  const [maxChainHops, setMaxChainHopsState] = useState(30)
  const [circuitBreaker, setCircuitBreakerState] = useState(true)
  const [defaultThinkingLevel, setDefaultThinkingLevelState] = useState<"off" | "minimal" | "low" | "medium" | "high" | "xhigh">("medium")
  const [allowCloud, setAllowCloudState] = useState(false)
  const [compactionReserveTokens, setCompactionReserveTokensState] = useState(38000)
  const [pendingRoute, setPendingRoute] = useState<RouteProposal[] | null>(null)
  const [maxRooms, setMaxRoomsState] = useState(8)
  const [conversations, setConversations] = useState<ConversationMeta[]>([])
  const [currentConversationId, setCurrentConversationId] = useState<string>("")
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [explicitlyEnabled, setExplicitlyEnabled] = useState<string[]>([])

  const messagesRef = useRef<Message[]>([])

  const pushNotice = useCallback((msg: string, level: "info" | "error" = "info") => {
    const id = noticeSeq++
    setNotices((n) => [...n, { id, msg, level }])
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), 5000)
  }, [])

  // Initial snapshot (transcript + workspace; roster also arrives over SSE).
  useEffect(() => {
    // Reset transient per-room state before loading the new room. These are
    // driven only by `turn`/`token`/`activity` SSE events, so a room switch
    // would otherwise leave them pinned to the previous room: the new room
    // never emits a `turn end` for a turn it didn't start, so a stale
    // `turnActive`/`paused` would stick indefinitely ("agents running…" with
    // the send button suppressed, or an ask_user prompt from the other room).
    setTurnActive(false)
    setRunningAgentId(null)
    setPaused(false)
    setPausedQuestion(null)
    setPausedAskerId(null)
    setPendingRoute(null)
    setStreaming({})
    setLiveActivity({})
    setLiveReasoning({})
    setReceipts({})
    rApi.transcript().then((m) => {
      messagesRef.current = m
      setMessages(m)
    }).catch(() => {})
    rApi.workspace().then(setWorkspace).catch(() => {})
    rApi.roster().then(setRoster).catch(() => {})
    rApi.settings().then((s) => {
      setChainingState(s.chaining)
      setRoutingModeState(s.routingMode)
      setDefaultAgentState(s.defaultAgent)
      if (s.fallbackAgent !== undefined) setFallbackAgentState(s.fallbackAgent)
      if (s.maxChainHops !== undefined) setMaxChainHopsState(s.maxChainHops)
      if (s.circuitBreaker !== undefined) setCircuitBreakerState(s.circuitBreaker)
      if (s.defaultThinkingLevel !== undefined) setDefaultThinkingLevelState(s.defaultThinkingLevel)
      if (s.allowCloud !== undefined) setAllowCloudState(s.allowCloud)
      if (s.compactionReserveTokens !== undefined) setCompactionReserveTokensState(s.compactionReserveTokens)
      if (s.maxRooms !== undefined) setMaxRoomsState(s.maxRooms)
      setPendingRoute(s.pendingRoute ? s.pendingRoute.proposals : null)
    }).catch(() => {})
    rApi.conversations().then((c) => {
      setConversations(c.list)
      setCurrentConversationId(c.currentId)
    }).catch(() => {})
    api.providers().then((d) => {
      setProviders(d.providers)
      setExplicitlyEnabled(d.explicitlyEnabled)
    }).catch(() => {})
  }, [rApi])

  // SSE stream — always the room-scoped endpoint (sseUrl is /api/rooms/:id/events
  // for every room, including "default"). Global /api/events is consumed only by
  // App.tsx, for room-lifecycle events.
  useEffect(() => {
    const es = new EventSource(sseUrl)
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)

    es.addEventListener("roster", (e) => setRoster(JSON.parse((e as MessageEvent).data)))

    es.addEventListener("status", (e) => {
      const data = JSON.parse((e as MessageEvent).data)
      setRoster((r) => r.map((p) => {
        if (p.id !== data.id) return p
        const base: RosterItem = { ...p, status: data.status }
        // Only update contextUsage when the payload explicitly carries it.
        // Mid-turn status events (e.g. "working") don't include it — preserving
        // the last known value prevents the progress bar from briefly clearing.
        if (data.contextUsage !== undefined) base.contextUsage = data.contextUsage
        // Forward sessionStats when present.
        if (data.sessionStats !== undefined) base.sessionStats = data.sessionStats
        // Forward retry metadata when present.
        if (data.retry !== undefined) base.retry = data.retry
        return base
      }))
    })

    es.addEventListener("token", (e) => {
      const { id, delta } = JSON.parse((e as MessageEvent).data)
      setStreaming((s) => ({ ...s, [id]: (s[id] ?? "") + delta }))
    })

    es.addEventListener("activity", (e) => {
      const { id, item } = JSON.parse((e as MessageEvent).data) as { id: string; item: ToolActivity }
      setLiveActivity((a) => {
        const list = a[id] ?? []
        const idx = list.findIndex((x) => x.toolCallId === item.toolCallId)
        const next = idx >= 0 ? list.map((x, i) => (i === idx ? item : x)) : [...list, item]
        return { ...a, [id]: next }
      })
    })

    es.addEventListener("reasoning", (e) => {
      const { id, delta } = JSON.parse((e as MessageEvent).data)
      setLiveReasoning((r) => ({ ...r, [id]: (r[id] ?? "") + delta }))
    })

    es.addEventListener("message", (e) => {
      const msg: Message = JSON.parse((e as MessageEvent).data)
      messagesRef.current = [...messagesRef.current, msg]
      setMessages(messagesRef.current)
      if (msg.author !== "user") {
        // The message now carries its final activity; drop the live buffers.
        setStreaming((s) => {
          const next = { ...s }
          delete next[msg.author]
          return next
        })
        setLiveActivity((a) => {
          const next = { ...a }
          delete next[msg.author]
          return next
        })
        setLiveReasoning((r) => {
          const next = { ...r }
          delete next[msg.author]
          return next
        })
      }
    })

    es.addEventListener("receipt", (e) => {
      const r: Receipt = JSON.parse((e as MessageEvent).data)
      const last = [...messagesRef.current].reverse().find((m) => m.author === r.participantId)
      if (last) setReceipts((rs) => ({ ...rs, [last.index]: r }))
    })

    es.addEventListener("workspace", (e) => setWorkspace(JSON.parse((e as MessageEvent).data)))

    es.addEventListener("notice", (e) => {
      const { msg, level } = JSON.parse((e as MessageEvent).data)
      pushNotice(msg, level)
    })

    es.addEventListener("turn", (e) => {
      const data = JSON.parse((e as MessageEvent).data)
      if (data.phase === "start") {
        setTurnActive(true)
        setRunningAgentId(data.agentId ?? null)
        setStreaming({})
        setLiveActivity({})
        setLiveReasoning({})
      } else if (data.phase === "end") {
        setTurnActive(false)
        setRunningAgentId(null)
        setPaused(false)
        setPausedQuestion(null)
        setPausedAskerId(null)
        setPendingRoute(null)
      } else if (data.phase === "pause") {
        setTurnActive(false)
        setPaused(true)
        setPausedQuestion(data.question ?? null)
        setPausedAskerId(data.askerId ?? null)
        pushNotice(`${data.askerId} is waiting for your answer.`)
      } else if (data.phase === "resume") {
        setPaused(false)
        setPausedQuestion(null)
        setPausedAskerId(null)
        setTurnActive(true)
        pushNotice(`Resuming — answering ${data.askerId}`)
      } else if (data.phase === "chain") {
        const to = (data.targets as string[]).map((t) => `@${t}`).join(" ")
        pushNotice(`@${data.from} → ${to}`)
      }
    })

    es.addEventListener("settings", (e) => {
      const { chaining: c, routingMode: rm, defaultAgent: d, fallbackAgent: fa, maxChainHops: m, circuitBreaker: cb, defaultThinkingLevel: dtl, allowCloud: ac, compactionReserveTokens: srt } = JSON.parse((e as MessageEvent).data)
      setChainingState(c)
      if (rm !== undefined) setRoutingModeState(rm)
      if (d !== undefined) setDefaultAgentState(d)
      if (fa !== undefined) setFallbackAgentState(fa)
      if (m !== undefined) setMaxChainHopsState(m)
      if (cb !== undefined) setCircuitBreakerState(cb)
      if (dtl !== undefined) setDefaultThinkingLevelState(dtl)
      if (ac !== undefined) setAllowCloudState(ac)
      if (srt !== undefined) setCompactionReserveTokensState(srt)
    })

    es.addEventListener("routing", (e) => {
      const data = JSON.parse((e as MessageEvent).data)
      if (data.type === "proposed") {
        setPendingRoute(data.proposals as RouteProposal[])
        setTurnActive(false) // paused for approval — not actively running
      } else if (data.type === "resolved") {
        setPendingRoute(null)
      }
    })

    // Full transcript replacement (conversation switch / new / load).
    es.addEventListener("transcript", (e) => {
      const msgs: Message[] = JSON.parse((e as MessageEvent).data)
      messagesRef.current = msgs
      setMessages(msgs)
      setStreaming({})
      setLiveActivity({})
      setLiveReasoning({})
      setReceipts({})
    })

    es.addEventListener("conversations", (e) => {
      const { currentId, list } = JSON.parse((e as MessageEvent).data)
      setConversations(list)
      setCurrentConversationId(currentId)
    })

    es.addEventListener("providers", (e) => {
      const data = JSON.parse((e as MessageEvent).data)
      if (data.providers) setProviders(data.providers)
      if (data.explicitlyEnabled) setExplicitlyEnabled(data.explicitlyEnabled)
    })

    es.addEventListener("oauth_progress", (e) => {
      const data = JSON.parse((e as MessageEvent).data)
      if (data.type === "device_code") {
        pushNotice(`OAuth for ${data.provider}: visit ${data.verificationUri}, enter code ${data.userCode}`)
      } else if (data.type === "auth_url") {
        pushNotice(`OAuth for ${data.provider}: ${data.instructions || "visit " + data.url}`)
      } else if (data.type === "progress") {
        pushNotice(`OAuth ${data.provider}: ${data.message}`)
      } else if (data.type === "success") {
        pushNotice(data.message)
      } else if (data.type === "error") {
        pushNotice(data.message, "error")
      }
    })

    return () => es.close()
  }, [pushNotice, sseUrl])

  const send = useCallback(
    (text: string, images?: string[]) => {
      rApi.sendMessage(text, images).catch((err) => pushNotice(String(err.message ?? err), "error"))
    },
    [pushNotice, rApi],
  )

  const setActive = useCallback(
    (id: string, active: boolean) => {
      rApi.setActive(id, active).catch((err) => pushNotice(String(err.message ?? err), "error"))
    },
    [pushNotice, rApi],
  )

  const setParallel = useCallback(
    (id: string, parallel: boolean) => {
      rApi.setParallel(id, parallel).catch((err) => pushNotice(String(err.message ?? err), "error"))
    },
    [pushNotice, rApi],
  )

  const kick = useCallback(
    (id: string) => {
      rApi.kick(id).catch((err) => pushNotice(String(err.message ?? err), "error"))
    },
    [pushNotice, rApi],
  )

  const createParticipant = useCallback(
    (body: Parameters<typeof rApi.create>[0]) =>
      rApi.create(body).catch((err) => {
        pushNotice(String(err.message ?? err), "error")
        throw err
      }),
    [pushNotice, rApi],
  )

  const addFromTemplate = useCallback(
    (templateId: string) =>
      rApi.addFromTemplate(templateId).catch((err) => {
        pushNotice(String(err.message ?? err), "error")
        throw err
      }),
    [pushNotice, rApi],
  )

  const savePreset = useCallback(
    (name: string) =>
      rApi.savePreset(name).catch((err) => {
        pushNotice(String(err.message ?? err), "error")
        throw err
      }),
    [pushNotice, rApi],
  )

  const loadPreset = useCallback(
    (name: string) =>
      rApi.loadPreset(name).catch((err) => {
        pushNotice(String(err.message ?? err), "error")
        throw err
      }),
    [pushNotice, rApi],
  )

  const applyPreset = useCallback(
    (name: string) =>
      rApi.applyPreset(name).catch((err) => {
        pushNotice(String(err.message ?? err), "error")
        throw err
      }),
    [pushNotice, rApi],
  )

  const getParticipant = useCallback((id: string) => rApi.participant(id), [rApi])

  const updateParticipant = useCallback(
    (id: string, patch: Parameters<typeof rApi.updateAgent>[1]) =>
      rApi.updateAgent(id, patch).catch((err) => {
        pushNotice(String(err.message ?? err), "error")
        throw err
      }),
    [pushNotice, rApi],
  )

  const reorderParticipants = useCallback(
    (order: string[]) => {
      // Optimistic: reorder the local roster immediately so the drag feels
      // instant; the server's "roster" broadcast then confirms it.
      setRoster((r) => {
        const byId = new Map(r.map((p) => [p.id, p]))
        const next = order.map((id) => byId.get(id)).filter(Boolean) as RosterItem[]
        for (const p of r) if (!order.includes(p.id)) next.push(p)
        return next
      })
      rApi.reorder(order).catch((err) => {
        pushNotice(String(err.message ?? err), "error")
        rApi.roster().then(setRoster).catch(() => {}) // revert to server truth
      })
    },
    [pushNotice, rApi],
  )

  const abort = useCallback(() => {
    rApi.abort().catch(() => {})
  }, [rApi])

  const steer = useCallback(
    (text: string, target: string) => {
      rApi.steerMessage(text, target).catch((err) => {
        const msg = String(err.message ?? err)
        if (msg.includes("not running") || msg.includes("cannot steer")) {
          pushNotice(`@${target} is not running — cannot steer`, "error")
        } else {
          pushNotice(msg, "error")
        }
      })
    },
    [pushNotice, rApi],
  )

  const compactAgent = useCallback(
    (id: string) => {
      pushNotice(`Compacting @${id}…`)
      rApi.compact(id)
        .then((r) => pushNotice(`@${id} compacted: ${r.tokensBefore} tokens before → summary generated.`))
        .catch((err) => pushNotice(String(err.message ?? err), "error"))
    },
    [pushNotice, rApi],
  )

  const setChaining = useCallback(
    (value: boolean) => {
      rApi.setChaining(value).then((s) => setChainingState(s.chaining)).catch((err) =>
        pushNotice(String(err.message ?? err), "error"),
      )
    },
    [pushNotice, rApi],
  )

  const setRoutingMode = useCallback(
    (mode: RoutingMode) => {
      rApi.setRoutingMode(mode).then((s) => setRoutingModeState(s.routingMode)).catch((err) =>
        pushNotice(String(err.message ?? err), "error"),
      )
    },
    [pushNotice, rApi],
  )

  const setCircuitBreaker = useCallback(
    (value: boolean) => {
      rApi.setCircuitBreaker(value).then((s) => setCircuitBreakerState(s.circuitBreaker)).catch((err) =>
        pushNotice(String(err.message ?? err), "error"),
      )
    },
    [pushNotice, rApi],
  )

  const setDefaultThinkingLevel = useCallback(
    (level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh") => {
      rApi.setDefaultThinkingLevel(level).then((s) => setDefaultThinkingLevelState(s.defaultThinkingLevel)).catch((err) =>
        pushNotice(String(err.message ?? err), "error"),
      )
    },
    [pushNotice, rApi],
  )

  const setAllowCloud = useCallback(
    (value: boolean) => {
      rApi.setAllowCloud(value).then((s) => setAllowCloudState(s.allowCloud)).catch((err) =>
        pushNotice(String(err.message ?? err), "error"),
      )
    },
    [pushNotice, rApi],
  )

  const setCompactionReserveTokens = useCallback(
    (value: number) => {
      rApi.setCompactionReserveTokens(value).then((s) => setCompactionReserveTokensState(s.compactionReserveTokens)).catch((err) =>
        pushNotice(String(err.message ?? err), "error"),
      )
    },
    [pushNotice, rApi],
  )

  const resolveRoute = useCallback(
    (decision: RouteDecision) => {
      setPendingRoute(null) // optimistic — the card disappears immediately
      rApi.resolveRoute(decision).catch((err) => pushNotice(String(err.message ?? err), "error"))
    },
    [pushNotice, rApi],
  )

  const setDefaultAgent = useCallback(
    (id: string | null) => {
      rApi.setDefaultAgent(id).then((s) => setDefaultAgentState(s.defaultAgent)).catch((err) =>
        pushNotice(String(err.message ?? err), "error"),
      )
    },
    [pushNotice, rApi],
  )

  const setFallbackAgent = useCallback(
    (id: string | null) => {
      rApi.setFallbackAgent(id).then((s) => setFallbackAgentState(s.fallbackAgent ?? null)).catch((err) =>
        pushNotice(String(err.message ?? err), "error"),
      )
    },
    [pushNotice, rApi],
  )

  const setMaxChainHops = useCallback(
    (n: number) => {
      rApi.setMaxChainHops(n).then((s) => setMaxChainHopsState(s.maxChainHops)).catch((err) =>
        pushNotice(String(err.message ?? err), "error"),
      )
    },
    [pushNotice, rApi],
  )

  const newConversation = useCallback(
    (title?: string) => {
      rApi.newConversation(title).catch((err) => pushNotice(String(err.message ?? err), "error"))
    },
    [pushNotice, rApi],
  )

  const loadConversation = useCallback(
    (id: string) => {
      if (id === currentConversationId) return
      rApi.loadConversation(id).catch((err) => pushNotice(String(err.message ?? err), "error"))
    },
    [pushNotice, rApi, currentConversationId],
  )

  const renameConversation = useCallback(
    (id: string, title: string) => {
      rApi.renameConversation(id, title).catch((err) =>
        pushNotice(String(err.message ?? err), "error"),
      )
    },
    [pushNotice, rApi],
  )

  const deleteConversation = useCallback(
    (id: string) => {
      rApi.deleteConversation(id).catch((err) => pushNotice(String(err.message ?? err), "error"))
    },
    [pushNotice, rApi],
  )

  const addProvider = useCallback(
    (name: string, key: string) => {
      api.addProvider(name, key).then(() => {
        pushNotice(`Provider "${name}" configured.`)
        // Refresh models so the dropdown picks up new models
        api.models().catch(() => {})
      }).catch((err) => pushNotice(String(err.message ?? err), "error"))
    },
    [pushNotice],
  )

  const removeProvider = useCallback(
    (name: string) => {
      api.removeProvider(name).then((r) => {
        let msg = `Provider "${name}" removed.`
        if (r.agentsUsing && r.agentsUsing.length > 0) {
          msg += ` Note: ${r.agentsUsing.join(", ")} may need model reassigned.`
        }
        pushNotice(msg)
      }).catch((err) => pushNotice(String(err.message ?? err), "error"))
    },
    [pushNotice],
  )

  const loginProvider = useCallback(
    (name: string) => {
      api.loginProvider(name).then(() => {
        pushNotice(`OAuth login started for ${name} — follow the instructions in notifications.`)
      }).catch((err) => pushNotice(String(err.message ?? err), "error"))
    },
    [pushNotice],
  )

  return {
    roster,
    messages,
    streaming,
    liveActivity,
    liveReasoning,
    receipts,
    workspace,
    notices,
    connected,
    turnActive,
    runningAgentId,
    paused,
    pausedQuestion,
    pausedAskerId,
    chaining,
    routingMode,
    defaultAgent,
    fallbackAgent,
    maxChainHops,
    circuitBreaker,
    defaultThinkingLevel,
    allowCloud,
    compactionReserveTokens,
    pendingRoute,
    maxRooms,
    conversations,
    currentConversationId,
    providers,
    explicitlyEnabled,
    addProvider,
    removeProvider,
    loginProvider,
    send,
    setActive,
    setParallel,
    kick,
    compactAgent,
    createParticipant,
    addFromTemplate,
    savePreset,
    loadPreset,
    applyPreset,
    getParticipant,
    updateParticipant,
    reorderParticipants,
    abort,
    steer,
    setChaining,
    setRoutingMode,
    resolveRoute,
    setDefaultAgent,
    setFallbackAgent,
    setMaxChainHops,
    setCircuitBreaker,
    setDefaultThinkingLevel,
    setAllowCloud,
    setCompactionReserveTokens,
    newConversation,
    loadConversation,
    renameConversation,
    deleteConversation,
  }
}
