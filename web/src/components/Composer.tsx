import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ClipboardEvent } from "react"
import type { RosterItem } from "../types"

interface Props {
  roster: RosterItem[]
  turnActive: boolean
  runningAgentId: string | null
  onSend: (text: string, images?: string[]) => void
  onAbort: () => void
  onSteer: (text: string, target: string) => void
}

/** Acceptable image mime types for paste/drag-drop. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])

/** Read a File as a base64 data URI. */
function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

export function Composer({ roster, turnActive, runningAgentId, onSend, onAbort, onSteer }: Props) {
  const [value, setValue] = useState("")
  const [partial, setPartial] = useState<string | null>(null)
  const [highlight, setHighlight] = useState(0)
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const [, setDragOver] = useState(false)
  const [steerSent, setSteerSent] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  // Clear steer-sent flash after a short delay.
  useEffect(() => {
    if (steerSent) {
      const t = setTimeout(() => setSteerSent(false), 2000)
      return () => clearTimeout(t)
    }
  }, [steerSent])

  const handles = useMemo(() => ["all", ...roster.map((r) => r.id)], [roster])
  const suggestions = useMemo(() => {
    if (partial === null) return []
    return handles.filter((h) => h.startsWith(partial.toLowerCase()))
  }, [partial, handles])

  // ── Image handling ────────────────────────────────────────────────────────

  const addImages = useCallback(async (files: FileList | File[]) => {
    const newUris: string[] = []
    for (const f of Array.from(files)) {
      if (!IMAGE_TYPES.has(f.type)) continue
      try {
        newUris.push(await fileToDataUri(f))
      } catch {
        // skip files that fail to read
      }
    }
    setPendingImages((prev) => [...prev, ...newUris])
  }, [])

  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      if (e.clipboardData?.files?.length) {
        e.preventDefault()
        void addImages(e.clipboardData.files)
      }
    },
    [addImages],
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      if (e.dataTransfer.files?.length) {
        void addImages(e.dataTransfer.files)
      }
    },
    [addImages],
  )

  // ── Mention handling ──────────────────────────────────────────────────────

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

  // ── Submit ────────────────────────────────────────────────────────────────

  function submit() {
    const text = value.trim()
    if (!text && pendingImages.length === 0) return

    if (turnActive && runningAgentId) {
      // Steer mode: redirect the running agent.
      onSteer(text, runningAgentId)
      setSteerSent(true)
    } else {
      // Normal mode: send a message to the room.
      onSend(text || "(image shared)", pendingImages.length > 0 ? pendingImages : undefined)
    }

    setValue("")
    setPartial(null)
    setPendingImages([])
  }

  // ── Remove a pending image ────────────────────────────────────────────────

  function removeImage(index: number) {
    setPendingImages((prev) => prev.filter((_, i) => i !== index))
  }

  // ── Render ────────────────────────────────────────────────────────────────

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

      {/* Image preview strip */}
      {pendingImages.length > 0 && (
        <div className="image-preview-strip">
          {pendingImages.map((uri, i) => (
            <div key={i} className="image-preview-thumb">
              <img src={uri} alt={`attachment ${i + 1}`} />
              <button
                className="image-preview-remove"
                onClick={() => removeImage(i)}
                title="Remove image"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="composer-row">
        <textarea
          ref={ref}
          className="composer-input"
          rows={3}
          value={value}
          placeholder="Message the room — @ summons an agent, paste or drop images"
          onPaste={handlePaste}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
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
          <>
            <button
              className="btn btn-steer"
              onClick={submit}
              title={`Steer @${runningAgentId ?? "agent"}`}
            >
              ↪ Steer{runningAgentId ? ` @${runningAgentId}` : ""}
            </button>
            <button className="btn btn-stop" onClick={onAbort} title="Abort current agent">
              ■ Stop
            </button>
          </>
        ) : (
          <button className="btn btn-send" onClick={submit}>
            Send
          </button>
        )}
      </div>

      {/* Steer sent flash */}
      {steerSent && (
        <div className="steer-flash">↪ steer sent — clearing on next response</div>
      )}
    </div>
  )
}
