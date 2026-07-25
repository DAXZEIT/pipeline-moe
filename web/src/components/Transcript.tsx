import { useEffect, useRef } from "react"
import { fmtDuration } from "@pipeline-moe/client-core"
import type { LivePart, Message, Receipt, RosterItem, ToolActivity } from "../types"
import { ActivityView } from "./ActivityView"
import { SequenceView, proseDrawn } from "./SequenceView"

interface Props {
  messages: Message[]
  streaming: Record<string, string>
  liveActivity: Record<string, ToolActivity[]>
  liveReasoning: Record<string, string>
  /** Segment boundaries stamped by the server for the turn in flight. */
  liveParts: Record<string, LivePart[]>
  receipts: Record<number, Receipt>
  roster: RosterItem[]
  /** Whether this room is the visible one (rooms stay mounted across switches). */
  active: boolean
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

function ImageGallery({ images }: { images: string[] }) {
  if (images.length === 0) return null
  return (
    <div className="image-gallery">
      {images.map((path, i) => (
        <img
          key={i}
          className="image-thumb"
          src={`/api/media/${path.split("/").pop()}`}
          alt={`attachment ${i + 1}`}
          loading="lazy"
        />
      ))}
    </div>
  )
}

export function Transcript({
  messages,
  streaming,
  liveActivity,
  liveReasoning,
  liveParts,
  receipts,
  roster,
  active,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null)
  // Jump instantly to the bottom on the initial load of a room (room switches
  // remount this component), and only animate for incremental updates afterwards.
  // Otherwise every tab switch shows a jarring top→bottom smooth-scroll.
  const settled = useRef(false)
  const byId = (id: string) => roster.find((r) => r.id === id)

  useEffect(() => {
    endRef.current?.scrollIntoView({
      behavior: settled.current ? "smooth" : "auto",
      block: "end",
    })
    if (messages.length > 0) settled.current = true
  }, [messages, streaming, liveActivity, liveReasoning, liveParts])

  // When this room becomes the visible one again, jump to the bottom: a hidden
  // transcript can't scroll, so content that streamed in while you were on
  // another room would otherwise sit below the fold.
  useEffect(() => {
    if (active) endRef.current?.scrollIntoView({ behavior: "auto", block: "end" })
  }, [active])

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
              {/* Author head for parity with agent replies (and the TUI's
                  "── You ──" rule) — the bubble alone reads ambiguously in a
                  long scrollback. */}
              <div className="agent-head user-head">
                <span className="agent-name">You</span>
              </div>
              {m.images && m.images.length > 0 && <ImageGallery images={m.images} />}
              <div className="bubble bubble-user">{m.text}</div>
            </div>
          )
        }
        if (m.author === "shell") {
          // A `!` command + its output — raw terminal text, not markdown.
          return (
            <div key={m.index} className="row agent">
              <div className="agent-head shell-head">
                <span>❯</span>
                <span className="agent-name">Shell</span>
              </div>
              <pre className="bubble bubble-shell">{m.text}</pre>
            </div>
          )
        }
        const r = byId(m.author)
        const color = r?.color ?? "#9aa0b5"
        // Chronological when the entry carries `parts`; grouped otherwise —
        // there are 67 M of pre-`parts` sessions and they must keep rendering.
        const interleaved = !!m.parts?.length
        const drawn = interleaved && proseDrawn(m.parts)
        return (
          <div key={m.index} className="row agent">
            <div className="agent-head" style={{ color }}>
              <span>{r?.icon}</span>
              <span className="agent-name">{m.authorName}</span>
              {m.durationMs != null && <span className="agent-duration">{fmtDuration(m.durationMs)}</span>}
            </div>
            {interleaved ? (
              <SequenceView parts={m.parts!} activity={m.activity} color={color} />
            ) : (
              <>
                {m.activity && m.activity.length > 0 && <ActivityView activity={m.activity} />}
                {m.reasoning && (
                  <details className="reasoning-done">
                    <summary>💭 thought</summary>
                    <pre>{m.reasoning}</pre>
                  </details>
                )}
              </>
            )}
            {/* An ask_user-only turn has empty text by design — the question
                callout below is the body, so render no (empty) bubble. With a
                sequence the prose is already in place; `m.text` is then a
                COMPOSED body and drawing it again would duplicate the reply. */}
            {m.text && !drawn && (
              <div className="bubble bubble-agent" style={{ borderColor: color }}>
                {m.text}
              </div>
            )}
            {m.question && (
              <div className="ask-callout">
                <span className="ask-callout-icon">🤚</span>
                <div className="ask-callout-body">
                  <span className="ask-callout-text">{m.question}</span>
                  {m.questionOptions && m.questionOptions.length > 0 && (
                    <ol className="ask-callout-options">
                      {m.questionOptions.map((o, i) => (
                        <li key={i}>{o}</li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>
            )}
            {/* Routing decision footer — a tool-only handoff is invisible in
                the reply text, so the next speaker otherwise reads as taking
                over at random (mirrors the TUI's "↪ handoff → @x" line). */}
            {m.handoffTo && (() => {
              const t = byId(m.handoffTo!)
              return (
                <div className="handoff-line">
                  <span className="handoff-arrow">↪</span>
                  <span>handoff</span>
                  <span className="handoff-target" style={t?.color ? { color: t.color } : undefined}>
                    {t?.icon && <span>{t.icon} </span>}@{m.handoffTo}
                  </span>
                </div>
              )
            })()}
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
        // The live sequence is the SAME sequence the entry will carry — the
        // server stamped the boundaries, so the turn does not visibly re-order
        // when the message lands (verified live, 2026-07-25: 9 segments
        // assembled from the stream, 9 persisted, identical).
        const parts = liveParts[id]
        return (
          <div key={`live-${id}`} className="row agent">
            <div className="agent-head" style={{ color }}>
              <span>{r?.icon}</span>
              <span className="agent-name">{r?.name ?? id}</span>
            </div>
            {parts?.length ? (
              <SequenceView parts={parts} activity={acts} color={color} live />
            ) : (
              <>
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
              </>
            )}
          </div>
        )
      })}

      <div ref={endRef} />
    </div>
  )
}
