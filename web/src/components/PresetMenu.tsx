import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../api"
import type { PresetFile } from "../types"

interface Props {
  turnActive: boolean
  /** Preset provenance + drift. null when the room isn't from a preset — the
   *  Restore/Save-back controls stay hidden. */
  drift?: { preset: string; deviates: boolean } | null
  onSave: (name: string) => Promise<unknown>
  onLoad: (name: string) => Promise<unknown>
  onApply: (name: string) => Promise<unknown>
  /** /preset pull — re-apply the source preset (restore the born-with roster). */
  onPull: (name: string) => Promise<unknown>
  /** /preset push — save the live roster back onto the source preset. */
  onPush: (name: string) => Promise<unknown>
}

export function PresetMenu({ turnActive, drift, onSave, onLoad, onApply, onPull, onPush }: Props) {
  const [open, setOpen] = useState(false)
  const [presets, setPresets] = useState<PresetFile[]>([])
  const [savingName, setSavingName] = useState("")
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [loadingName, setLoadingName] = useState<string | null>(null)
  const [applyingName, setApplyingName] = useState<string | null>(null)
  const [driftBusy, setDriftBusy] = useState<"pull" | "push" | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Fetch presets on open.
  useEffect(() => {
    if (!open) return
    api.presets().then(setPresets).catch(() => {})
  }, [open])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
        setSavingName("")
        setConfirmId(null)
      }
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])

  // Refresh presets after a mutation.
  const refresh = useCallback(() => {
    api.presets().then(setPresets).catch(() => {})
  }, [])

  const handleSave = () => {
    const name = savingName.trim()
    if (!name) return
    onSave(name).then(() => {
      setSavingName("")
      refresh()
    }).catch((err) => {
      alert(String(err.message ?? err))
    })
  }

  const handleLoad = (name: string) => {
    setLoadingName(name)
    onLoad(name).then(() => {
      setOpen(false)
      setLoadingName(null)
    }).catch((err) => {
      setLoadingName(null)
      alert(String(err.message ?? err))
    })
  }

  const handleApply = (name: string) => {
    setApplyingName(name)
    onApply(name).then(() => {
      setOpen(false)
      setApplyingName(null)
    }).catch((err) => {
      setApplyingName(null)
      alert(String(err.message ?? err))
    })
  }

  const handleDelete = (name: string) => {
    if (confirmId !== name) {
      setConfirmId(name)
      return
    }
    api.deletePreset(name).then(() => {
      setConfirmId(null)
      refresh()
    }).catch((err) => {
      alert(String(err.message ?? err))
    })
  }

  // Restore (pull) / Save-back (push) target the source preset EXCLUSIVELY —
  // never a name typed elsewhere. Server enforces name === sourcePreset too.
  const handlePull = () => {
    if (!drift) return
    setDriftBusy("pull")
    onPull(drift.preset).then(() => {
      setDriftBusy(null)
      setOpen(false)
    }).catch((err) => {
      setDriftBusy(null)
      alert(String(err.message ?? err))
    })
  }

  const handlePush = () => {
    if (!drift) return
    setDriftBusy("push")
    onPush(drift.preset).then(() => {
      setDriftBusy(null)
      refresh()
    }).catch((err) => {
      setDriftBusy(null)
      alert(String(err.message ?? err))
    })
  }

  const hasCloud = (p: PresetFile) => p.personas.some((pp) => pp.model && !pp.model.startsWith("local/"))

  return (
    <div className="preset-bar" ref={wrapRef}>
      <button
        className="preset-trigger"
        onClick={() => setOpen((o) => !o)}
        title="Room presets"
      >
        🎯 <span className="preset-caret">▾</span>
      </button>

      {open && (
        <div className="preset-menu">
          {drift && (
            <div className="preset-section preset-drift-section">
              <label className="preset-label">
                From preset “{drift.preset}”
                {drift.deviates && <span className="preset-drift-star" title="Live roster deviates from this preset">*</span>}
              </label>
              {drift.deviates ? (
                <>
                  <div className="preset-drift-note">The live roster deviates from this preset.</div>
                  <div className="preset-drift-actions">
                    <button
                      className="preset-save-btn"
                      title={`Restore the roster saved in preset "${drift.preset}"`}
                      disabled={turnActive || driftBusy !== null}
                      onClick={handlePull}
                    >
                      {driftBusy === "pull" ? "restoring…" : "Restore"}
                    </button>
                    <button
                      className="preset-save-btn"
                      title={`Save the live roster back onto preset "${drift.preset}"`}
                      disabled={turnActive || driftBusy !== null}
                      onClick={handlePush}
                    >
                      {driftBusy === "push" ? "saving…" : "Save to preset"}
                    </button>
                  </div>
                </>
              ) : (
                <div className="preset-drift-note">Roster matches the preset.</div>
              )}
            </div>
          )}
          <div className="preset-section">
            <label className="preset-label">Save current roster</label>
            <div className="preset-save-row">
              <input
                className="preset-input"
                placeholder="preset name…"
                value={savingName}
                onChange={(e) => setSavingName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSave()}
                disabled={turnActive}
              />
              <button
                className="preset-save-btn"
                onClick={handleSave}
                disabled={turnActive || !savingName.trim()}
              >
                Save
              </button>
            </div>
          </div>

          <div className="preset-section">
            <label className="preset-label">Loaded presets</label>
            {presets.length === 0 && (
              <div className="preset-empty">No saved presets</div>
            )}
            {presets.map((p) => (
              <div key={p.name} className="preset-item">
                <div className="preset-item-info">
                  <span className="preset-name">{p.name}</span>
                  <span className="preset-agent-count">{p.personas.length} agents</span>
                  {hasCloud(p) && <span className="preset-cloud" title="Uses cloud models">☁</span>}
                </div>
                <div className="preset-item-actions">
                  {loadingName === p.name ? (
                    <span className="preset-loading">loading…</span>
                  ) : (
                    <button
                      className="mini"
                      title="Load preset (new conversation)"
                      disabled={turnActive}
                      onClick={() => handleLoad(p.name)}
                    >
                      ▶
                    </button>
                  )}
                  {applyingName === p.name ? (
                    <span className="preset-loading">applying…</span>
                  ) : (
                    <button
                      className="mini"
                      title="Apply preset (in-place)"
                      disabled={turnActive}
                      onClick={() => handleApply(p.name)}
                    >
                      ↻
                    </button>
                  )}
                  {confirmId === p.name ? (
                    <button
                      className="mini danger"
                      title="Confirm delete"
                      onClick={() => handleDelete(p.name)}
                    >
                      ✓
                    </button>
                  ) : (
                    <button
                      className="mini danger"
                      title="Delete"
                      onClick={() => handleDelete(p.name)}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
