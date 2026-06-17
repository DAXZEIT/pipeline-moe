import { useEffect, useRef, useState } from "react"
import type { ConversationMeta } from "../types"

interface Props {
  conversations: ConversationMeta[]
  currentId: string
  turnActive: boolean
  onSwitch: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
}

export function ConversationBar({
  conversations,
  currentId,
  turnActive,
  onSwitch,
  onNew,
  onRename,
  onDelete,
}: Props) {
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const current = conversations.find((c) => c.id === currentId)

  // Close the menu on outside click.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
        setEditingId(null)
        setConfirmId(null)
      }
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])

  const startRename = (c: ConversationMeta) => {
    setEditingId(c.id)
    setDraft(c.title)
    setConfirmId(null)
  }

  const commitRename = () => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim())
    setEditingId(null)
  }

  return (
    <div className="conv-bar" ref={wrapRef}>
      <button
        className="conv-trigger"
        onClick={() => setOpen((o) => !o)}
        title="Switch discussion"
      >
        💬 <span className="conv-trigger-title">{current?.title ?? "—"}</span>
        <span className="conv-caret">▾</span>
      </button>

      {open && (
        <div className="conv-menu">
          <div className="conv-list">
            {conversations.length === 0 && <div className="conv-empty">No saved discussions</div>}
            {conversations.map((c) => (
              <div
                key={c.id}
                className={`conv-item ${c.id === currentId ? "active" : ""}`}
              >
                {editingId === c.id ? (
                  <input
                    className="conv-edit"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename()
                      if (e.key === "Escape") setEditingId(null)
                    }}
                    onBlur={commitRename}
                  />
                ) : (
                  <button
                    className="conv-name"
                    disabled={turnActive && c.id !== currentId}
                    onClick={() => {
                      onSwitch(c.id)
                      setOpen(false)
                    }}
                  >
                    <span className="conv-name-text">{c.title}</span>
                    <span className="conv-count">{c.messageCount}</span>
                  </button>
                )}

                <div className="conv-item-actions">
                  <button className="mini" title="Rename" onClick={() => startRename(c)}>
                    ✎
                  </button>
                  {confirmId === c.id ? (
                    <button
                      className="mini danger"
                      title="Confirm delete"
                      onClick={() => {
                        onDelete(c.id)
                        setConfirmId(null)
                      }}
                    >
                      ✓
                    </button>
                  ) : (
                    <button
                      className="mini danger"
                      title="Delete"
                      disabled={turnActive}
                      onClick={() => setConfirmId(c.id)}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <button
            className="conv-new"
            disabled={turnActive}
            onClick={() => {
              onNew()
              setOpen(false)
            }}
          >
            ＋ New discussion
          </button>
        </div>
      )}
    </div>
  )
}
