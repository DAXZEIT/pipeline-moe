import { useCallback, useEffect, useRef, useState } from "react"
import { api, API_BASE } from "./api"
import type {
  ConversationMeta,
  Message,
  Notice,
  Receipt,
  RosterItem,
  ToolActivity,
  WorkspaceFile,
} from "./types"

let noticeSeq = 1

export function useRoom() {
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
  const [paused, setPaused] = useState(false)
  const [chaining, setChainingState] = useState(true)
  const [defaultAgent, setDefaultAgentState] = useState<string | null>(null)
  const [conversations, setConversations] = useState<ConversationMeta[]>([])
  const [currentConversationId, setCurrentConversationId] = useState<string>("")

  const messagesRef = useRef<Message[]>([])

  const pushNotice = useCallback((msg: string, level: "info" | "error" = "info") => {
    const id = noticeSeq++
    setNotices((n) => [...n, { id, msg, level }])
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), 5000)
  }, [])

  // Initial snapshot (transcript + workspace; roster also arrives over SSE).
  useEffect(() => {
    api.transcript().then((m) => {
      messagesRef.current = m
      setMessages(m)
    }).catch(() => {})
    api.workspace().then(setWorkspace).catch(() => {})
    api.roster().then(setRoster).catch(() => {})
    api.settings().then((s) => {
      setChainingState(s.chaining)
      setDefaultAgentState(s.defaultAgent)
    }).catch(() => {})
    api.conversations().then((c) => {
      setConversations(c.list)
      setCurrentConversationId(c.currentId)
    }).catch(() => {})
  }, [])

  // SSE stream.
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/events`)
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)

    es.addEventListener("roster", (e) => setRoster(JSON.parse((e as MessageEvent).data)))

    es.addEventListener("status", (e) => {
      const { id, status } = JSON.parse((e as MessageEvent).data)
      setRoster((r) => r.map((p) => (p.id === id ? { ...p, status } : p)))
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
        setStreaming({})
        setLiveActivity({})
        setLiveReasoning({})
      } else if (data.phase === "end") {
        setTurnActive(false)
        setPaused(false)
      } else if (data.phase === "pause") {
        setTurnActive(false)
        setPaused(true)
        pushNotice(`${data.askerId} is waiting for your answer.`)
      } else if (data.phase === "resume") {
        setPaused(false)
        setTurnActive(true)
        pushNotice(`Resuming — answering ${data.askerId}`)
      } else if (data.phase === "chain") {
        const to = (data.targets as string[]).map((t) => `@${t}`).join(" ")
        pushNotice(`@${data.from} → ${to}`)
      }
    })

    es.addEventListener("settings", (e) => {
      const { chaining: c, defaultAgent: d } = JSON.parse((e as MessageEvent).data)
      setChainingState(c)
      if (d !== undefined) setDefaultAgentState(d)
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

    return () => es.close()
  }, [pushNotice])

  const send = useCallback(
    (text: string, images?: string[]) => {
      api.sendMessage(text, images).catch((err) => pushNotice(String(err.message ?? err), "error"))
    },
    [pushNotice],
  )

  const setActive = useCallback(
    (id: string, active: boolean) => {
      api.setActive(id, active).catch((err) => pushNotice(String(err.message ?? err), "error"))
    },
    [pushNotice],
  )

  const setParallel = useCallback(
    (id: string, parallel: boolean) => {
      api.setParallel(id, parallel).catch((err) => pushNotice(String(err.message ?? err), "error"))
    },
    [pushNotice],
  )

  const kick = useCallback(
    (id: string) => {
      api.kick(id).catch((err) => pushNotice(String(err.message ?? err), "error"))
    },
    [pushNotice],
  )

  const createParticipant = useCallback(
    (body: Parameters<typeof api.create>[0]) =>
      api.create(body).catch((err) => {
        pushNotice(String(err.message ?? err), "error")
        throw err
      }),
    [pushNotice],
  )

  const updateParticipant = useCallback(
    (id: string, patch: Parameters<typeof api.updateAgent>[1]) =>
      api.updateAgent(id, patch).catch((err) => {
        pushNotice(String(err.message ?? err), "error")
        throw err
      }),
    [pushNotice],
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
      api.reorder(order).catch((err) => {
        pushNotice(String(err.message ?? err), "error")
        api.roster().then(setRoster).catch(() => {}) // revert to server truth
      })
    },
    [pushNotice],
  )

  const abort = useCallback(() => {
    api.abort().catch(() => {})
  }, [])

  const compactAgent = useCallback(
    (id: string) => {
      pushNotice(`Compacting @${id}…`)
      api.compact(id)
        .then((r) => pushNotice(`@${id} compacted: ${r.tokensBefore} tokens before → summary generated.`))
        .catch((err) => pushNotice(String(err.message ?? err), "error"))
    },
    [pushNotice],
  )

  const setChaining = useCallback(
    (value: boolean) => {
      api.setChaining(value).then((s) => setChainingState(s.chaining)).catch((err) =>
        pushNotice(String(err.message ?? err), "error"),
      )
    },
    [pushNotice],
  )

  const setDefaultAgent = useCallback(
    (id: string | null) => {
      api.setDefaultAgent(id).then((s) => setDefaultAgentState(s.defaultAgent)).catch((err) =>
        pushNotice(String(err.message ?? err), "error"),
      )
    },
    [pushNotice],
  )

  const newConversation = useCallback(
    (title?: string) => {
      api.newConversation(title).catch((err) => pushNotice(String(err.message ?? err), "error"))
    },
    [pushNotice],
  )

  const loadConversation = useCallback(
    (id: string) => {
      if (id === currentConversationId) return
      api.loadConversation(id).catch((err) => pushNotice(String(err.message ?? err), "error"))
    },
    [pushNotice, currentConversationId],
  )

  const renameConversation = useCallback(
    (id: string, title: string) => {
      api.renameConversation(id, title).catch((err) =>
        pushNotice(String(err.message ?? err), "error"),
      )
    },
    [pushNotice],
  )

  const deleteConversation = useCallback(
    (id: string) => {
      api.deleteConversation(id).catch((err) => pushNotice(String(err.message ?? err), "error"))
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
    paused,
    chaining,
    defaultAgent,
    conversations,
    currentConversationId,
    send,
    setActive,
    setParallel,
    kick,
    compactAgent,
    createParticipant,
    updateParticipant,
    reorderParticipants,
    abort,
    setChaining,
    setDefaultAgent,
    newConversation,
    loadConversation,
    renameConversation,
    deleteConversation,
  }
}
