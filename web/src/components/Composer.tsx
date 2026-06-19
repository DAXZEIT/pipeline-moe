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

/** Slash commands with syntax and description. */
const SLASH_COMMANDS = [
  { cmd: "help", syntax: "/help", desc: "List all available commands" },
  { cmd: "kick", syntax: "/kick @agent", desc: "Remove agent from room" },
  { cmd: "activate", syntax: "/activate @agent", desc: "Enable a deactivated agent" },
  { cmd: "deactivate", syntax: "/deactivate @agent", desc: "Disable an active agent" },
  { cmd: "compact", syntax: "/compact @agent", desc: "Compact agent context" },
  { cmd: "model", syntax: "/model @agent provider/id", desc: "Change agent model" },
  { cmd: "thinking", syntax: "/thinking [level|@agent level]", desc: "Set thinking level" },
  { cmd: "stats", syntax: "/stats [@agent]", desc: "Show token & context stats" },
  { cmd: "chaining", syntax: "/chaining on|off", desc: "Toggle followUp self-chaining" },
  { cmd: "default", syntax: "/default @agent|none", desc: "Set/clear default agent" },
]

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
  const [trigger, setTrigger] = useState<"@" | "/" | null>(null)
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
    if (partial === null || trigger === null) return []
    if (trigger === "@") {
      return handles.filter((h) => h.startsWith(partial.toLowerCase()))
    }
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(partial.toLowerCase()))
  }, [partial, trigger, handles])

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

  // ── Mention & slash handling ──────────────────────────────────────────────

  function recomputePartial(text: string, caret: number) {
    const before = text.slice(0, caret)
    const m = before.match(/(@|\/)(\w*)$/)
    if (m) {
      const marker = m[1]
      // For "/" — only trigger at start of line (like Discord/Slack)
      if (marker === "/") {
        const pos = before.lastIndexOf(m[0])
        const atLineStart = pos === 0 || before[pos - 1] === "\n"
        if (!atLineStart) {
          setTrigger(null)
          setPartial(null)
          return
        }
      }
      setTrigger(marker as "@" | "/")
      setPartial(m[2])
      setHighlight(0)
    } else {
      setTrigger(null)
      setPartial(null)
    }
  }

  function acceptSuggestion(item: string) {
    const el = ref.current
    const caret = el?.selectionStart ?? value.length
    let before: string
    if (trigger === "@") {
      before = value.slice(0, caret).replace(/@(\w*)$/, `@${item} `)
    } else {
      before = value.slice(0, caret).replace(/\/(\w*)$/, `/${item} `)
    }
    const next = before + value.slice(caret)
    setValue(next)
    setTrigger(null)
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
    setTrigger(null)
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
          {trigger === "/" ? (
            suggestions.map((c, i) => (
              <div
                key={c.cmd}
                className={`mention-item ${i === highlight ? "active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  acceptSuggestion(c.cmd)
                }}
              >
                <span className="mention-icon">⌘</span>
                <span>{c.syntax}</span>
                <span className="mention-hint">{c.desc}</span>
              </div>
            ))
          ) : (
            suggestions.map((h, i) => {
              const r = roster.find((x) => x.id === h)
              return (
                <div
                  key={h}
                  className={`mention-item ${i === highlight ? "active" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    acceptSuggestion(h)
                  }}
                >
                  <span className="mention-icon" style={{ color: r?.color ?? "#9aa" }}>
                    {r?.icon ?? "👥"}
                  </span>
                  <span>@{h}</span>
                  {h === "all" && <span className="mention-hint">everyone active</span>}
                </div>
              )
            })
          )}
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
          placeholder="Message the room — @ mentions, / commands, paste or drop images"
          onPaste={handlePaste}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onChange={(e) => {
            setValue(e.target.value)
            recomputePartial(e.target.value, e.target.selectionStart ?? e.target.value.length)
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
                if (trigger === "/") {
                  acceptSuggestion((suggestions[highlight] as { cmd: string }).cmd)
                } else {
                  acceptSuggestion(suggestions[highlight] as string)
                }
                return
              }
              if (e.key === "Escape") {
                setTrigger(null)
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
