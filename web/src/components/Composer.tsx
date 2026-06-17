import { useMemo, useRef, useState } from "react"
import type { RosterItem } from "../types"

interface Props {
  roster: RosterItem[]
  turnActive: boolean
  onSend: (text: string) => void
  onAbort: () => void
}

export function Composer({ roster, turnActive, onSend, onAbort }: Props) {
  const [value, setValue] = useState("")
  const [partial, setPartial] = useState<string | null>(null)
  const [highlight, setHighlight] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)

  const handles = useMemo(() => ["all", ...roster.map((r) => r.id)], [roster])
  const suggestions = useMemo(() => {
    if (partial === null) return []
    return handles.filter((h) => h.startsWith(partial.toLowerCase()))
  }, [partial, handles])

  function recomputeMention(text: string, caret: number) {
    const before = text.slice(0, caret)
    const m = before.match(/@(\w*)$/)
    setPartial(m ? m[1] : null)
    setHighlight(0)
  }

  function accept(handle: string) {
    const el = ref.current
    const caret = el?.selectionStart ?? value.length
    const before = value.slice(0, caret).replace(/@(\w*)$/, `@${handle} `)
    const next = before + value.slice(caret)
    setValue(next)
    setPartial(null)
    queueMicrotask(() => el?.focus())
  }

  function submit() {
    const text = value.trim()
    if (!text) return
    onSend(text)
    setValue("")
    setPartial(null)
  }

  return (
    <div className="composer">
      {suggestions.length > 0 && (
        <div className="mention-pop">
          {suggestions.map((h, i) => {
            const r = roster.find((x) => x.id === h)
            return (
              <div
                key={h}
                className={`mention-item ${i === highlight ? "active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  accept(h)
                }}
              >
                <span className="mention-icon" style={{ color: r?.color ?? "#9aa" }}>
                  {r?.icon ?? "👥"}
                </span>
                <span>@{h}</span>
                {h === "all" && <span className="mention-hint">everyone active</span>}
              </div>
            )
          })}
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={ref}
          className="composer-input"
          rows={1}
          value={value}
          placeholder="Message the room — @ summons an agent, /kick @name removes one"
          onChange={(e) => {
            setValue(e.target.value)
            recomputeMention(e.target.value, e.target.selectionStart ?? e.target.value.length)
          }}
          onKeyDown={(e) => {
            if (suggestions.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault()
                setHighlight((h) => (h + 1) % suggestions.length)
                return
              }
              if (e.key === "ArrowUp") {
                e.preventDefault()
                setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length)
                return
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault()
                accept(suggestions[highlight])
                return
              }
              if (e.key === "Escape") {
                setPartial(null)
                return
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {turnActive ? (
          <button className="btn btn-stop" onClick={onAbort} title="Abort current agent">
            ■ Stop
          </button>
        ) : (
          <button className="btn btn-send" onClick={submit}>
            Send
          </button>
        )}
      </div>
    </div>
  )
}
