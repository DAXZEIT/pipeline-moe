import { useEffect, useState } from "react"
import { api } from "../api"
import type { PresetFile, ResumableRoom, RoomSummary } from "../types"

interface Props {
  onClose: () => void
  onCreated: (room: RoomSummary) => void
}

type Mode = "create" | "resume"

/** Compact relative time for the resume list. */
function timeAgo(ts: number): string {
  if (!ts) return "—"
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return "just now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

export function CreateRoomDialog({ onClose, onCreated }: Props) {
  const [mode, setMode] = useState<Mode>("create")

  // ── Create state ──
  const [name, setName] = useState("")
  const [presetName, setPresetName] = useState("")
  const [goal, setGoal] = useState("")
  const [workspaceDir, setWorkspaceDir] = useState("")
  const [presets, setPresets] = useState<PresetFile[]>([])

  // ── Shared ──
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Resume state ── (null = not loaded yet)
  const [resumable, setResumable] = useState<ResumableRoom[] | null>(null)

  useEffect(() => {
    api.presets().then(setPresets).catch(() => {})
  }, [])

  // Lazily fetch resumable rooms when the Resume tab is opened.
  useEffect(() => {
    if (mode !== "resume") return
    setResumable(null)
    setError(null)
    api
      .resumableRooms()
      .then(setResumable)
      .catch((err) => {
        setResumable([])
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [mode])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) { setError("Name is required"); return }
    setSubmitting(true)
    setError(null)
    try {
      const room = await api.createRoom({
        name: trimmedName,
        ...(presetName ? { preset: presetName } : {}),
        ...(goal.trim() ? { goal: goal.trim() } : {}),
        ...(workspaceDir.trim() ? { workspaceDir: workspaceDir.trim() } : {}),
      })
      onCreated(room)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  const handleResume = async (roomId: string) => {
    setSubmitting(true)
    setError(null)
    try {
      const room = await api.resumeRoom(roomId)
      onCreated(room)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  // Close on backdrop click.
  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div className="dialog-backdrop" onClick={handleBackdrop}>
      <div className="create-room-dialog">
        <div className="dialog-header">
          <div className="dialog-tabs">
            <button
              className={`dialog-tab${mode === "create" ? " active" : ""}`}
              onClick={() => setMode("create")}
            >
              Create new
            </button>
            <button
              className={`dialog-tab${mode === "resume" ? " active" : ""}`}
              onClick={() => setMode("resume")}
            >
              Resume
            </button>
          </div>
          <button className="dialog-close" onClick={onClose}>×</button>
        </div>

        {mode === "create" ? (
          <form className="dialog-body" onSubmit={handleSubmit}>
            <label className="dialog-field">
              <span>Name</span>
              <input
                type="text"
                className="dialog-input"
                placeholder="e.g. Cloud Sprint"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </label>

            <label className="dialog-field">
              <span>Preset roster</span>
              <select
                className="dialog-input"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
              >
                <option value="">— default roster —</option>
                {presets.map((p) => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
            </label>

            <label className="dialog-field">
              <span>Working directory <span className="muted">(optional — default: pipeline workspace)</span></span>
              <input
                type="text"
                className="dialog-input"
                placeholder="/path/to/project  or  user@host:/path/to/project"
                value={workspaceDir}
                onChange={(e) => setWorkspaceDir(e.target.value)}
              />
              <span className="dialog-hint muted">
                Local path, or a remote <code>user@host:/path</code> (mounted over SSHFS —
                files are remote, but commands still run locally).
              </span>
            </label>

            <label className="dialog-field">
              <span>Goal <span className="muted">(optional — auto-starts the room)</span></span>
              <textarea
                className="dialog-input dialog-textarea"
                placeholder="Describe the goal for this room's agents…"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                rows={3}
              />
            </label>

            {error && <div className="dialog-error">{error}</div>}

            <div className="dialog-actions">
              <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={submitting || !name.trim()}>
                {submitting ? "Creating…" : "Create room"}
              </button>
            </div>
          </form>
        ) : (
          <div className="dialog-body">
            <span className="dialog-hint muted">
              Reopen a room you closed earlier. Its transcript, roster, and goal history are
              restored from disk.
            </span>

            {resumable === null && <div className="dialog-hint muted">Loading…</div>}

            {error && <div className="dialog-error">{error}</div>}

            {resumable && resumable.length === 0 && !error && (
              <div className="dialog-hint muted">
                No closed rooms to resume. Destroying a room keeps its transcript here until you
                reopen it.
              </div>
            )}

            {resumable && resumable.length > 0 && (
              <ul className="resume-list">
                {resumable.map((r) => (
                  <li key={r.roomId}>
                    <button
                      className="resume-item"
                      onClick={() => handleResume(r.roomId)}
                      disabled={submitting}
                      title={`${r.roomId}${r.workspaceDir ? ` — ${r.workspaceDir}` : ""}`}
                    >
                      <span className="resume-name">{r.name}</span>
                      <span className="resume-meta muted">
                        {r.messageCount} msg · {timeAgo(r.lastActivity)}
                        {r.workspaceDir ? ` · ${r.workspaceDir}` : ""}
                        {!r.hasMeta && " · legacy"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="dialog-actions">
              <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
