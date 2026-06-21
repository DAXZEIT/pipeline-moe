import { useEffect, useState } from "react"
import { api } from "../api"
import type { PresetFile, RoomSummary } from "../types"

interface Props {
  onClose: () => void
  onCreated: (room: RoomSummary) => void
}

export function CreateRoomDialog({ onClose, onCreated }: Props) {
  const [name, setName] = useState("")
  const [presetName, setPresetName] = useState("")
  const [goal, setGoal] = useState("")
  const [workspaceDir, setWorkspaceDir] = useState("")
  const [presets, setPresets] = useState<PresetFile[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.presets().then(setPresets).catch(() => {})
  }, [])

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

  // Close on backdrop click.
  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div className="dialog-backdrop" onClick={handleBackdrop}>
      <div className="create-room-dialog">
        <div className="dialog-header">
          <span className="dialog-title">New room</span>
          <button className="dialog-close" onClick={onClose}>×</button>
        </div>

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
              placeholder="/home/dax/projects/foo  or  dax@10.0.0.1:/home/dax/foo"
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
      </div>
    </div>
  )
}
