import { useEffect, useRef } from "react"
import type { Message, Receipt, RosterItem, ToolActivity } from "../types"
import { ActivityView } from "./ActivityView"

interface Props {
  messages: Message[]
  streaming: Record<string, string>
  liveActivity: Record<string, ToolActivity[]>
  liveReasoning: Record<string, string>
  receipts: Record<number, Receipt>
  roster: RosterItem[]
}

function ReceiptView({ r }: { r: Receipt }) {
  const chips = [
    ...r.created.map((p) => ({ p, kind: "+" })),
    ...r.modified.map((p) => ({ p, kind: "~" })),
    ...r.deleted.map((p) => ({ p, kind: "−" })),
  ]
  if (chips.length === 0) return null
  return (
    <div className="receipt">
      <div className="receipt-label">WORK RECEIPT — filesystem-verified</div>
      <div className="receipt-chips">
        {chips.map(({ p, kind }) => (
          <span key={kind + p} className={`chip-file kind-${kind === "+" ? "add" : kind === "~" ? "mod" : "del"}`}>
            {kind} {p}
          </span>
        ))}
      </div>
    </div>
  )
}

export function Transcript({
  messages,
  streaming,
  liveActivity,
  liveReasoning,
  receipts,
  roster,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null)
  const byId = (id: string) => roster.find((r) => r.id === id)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages, streaming, liveActivity, liveReasoning])

  // Agents currently producing something: streaming text, tool calls, or reasoning.
  const liveIds = [
    ...new Set([
      ...Object.keys(streaming).filter((id) => (streaming[id]?.length ?? 0) > 0),
      ...Object.keys(liveActivity),
      ...Object.keys(liveReasoning),
    ]),
  ]

  return (
    <div className="transcript">
      {messages.map((m) => {
        if (m.author === "user") {
          return (
            <div key={m.index} className="row user">
              <div className="bubble bubble-user">{m.text}</div>
            </div>
          )
        }
        const r = byId(m.author)
        const color = r?.color ?? "#9aa0b5"
        return (
          <div key={m.index} className="row agent">
            <div className="agent-head" style={{ color }}>
              <span>{r?.icon}</span>
              <span className="agent-name">{m.authorName}</span>
            </div>
            {m.activity && m.activity.length > 0 && <ActivityView activity={m.activity} />}
            <div className="bubble bubble-agent" style={{ borderColor: color }}>
              {m.text}
            </div>
            {receipts[m.index] && <ReceiptView r={receipts[m.index]} />}
          </div>
        )
      })}

      {liveIds.map((id) => {
        const r = byId(id)
        const color = r?.color ?? "#9aa0b5"
        const text = streaming[id] ?? ""
        const acts = liveActivity[id] ?? []
        const reasoning = liveReasoning[id] ?? ""
        return (
          <div key={`live-${id}`} className="row agent">
            <div className="agent-head" style={{ color }}>
              <span>{r?.icon}</span>
              <span className="agent-name">{r?.name ?? id}</span>
            </div>
            {reasoning && (
              <details className="reasoning-live">
                <summary>💭 thinking…</summary>
                <pre>{reasoning}</pre>
              </details>
            )}
            {acts.length > 0 && <ActivityView activity={acts} live />}
            {text.length > 0 && (
              <div className="bubble bubble-agent streaming" style={{ borderColor: color }}>
                {text}
                <span className="caret" />
              </div>
            )}
          </div>
        )
      })}

      <div ref={endRef} />
    </div>
  )
}
