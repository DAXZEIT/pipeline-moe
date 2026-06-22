import { useEffect, useState } from "react"
import { api } from "../api"
import type { PresetFile, PresetPersona } from "../types"

/** Short, readable model label — drops the provider prefix. */
function modelLabel(p: PresetPersona): string {
  if (!p.model) return "default model"
  const parts = p.model.split("/")
  return parts.length > 1 ? parts.slice(1).join("/") : p.model
}

/** Detailed, read-only browser for saved presets and their member rosters.
 *  Lives in the right-hand side panel's "Presets" tab. Load/Apply reuse the
 *  same endpoints as the compact 🎯 menu. */
export function PresetsPanel({ turnActive }: { turnActive: boolean }) {
  const [presets, setPresets] = useState<PresetFile[] | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.presets().then(setPresets).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  const act = async (name: string, kind: "load" | "apply") => {
    setBusy(`${kind}:${name}`)
    setError(null)
    try {
      await (kind === "load" ? api.loadPreset(name) : api.applyPreset(name))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  if (error && !presets) return <div className="presets-error">{error}</div>
  if (presets === null) return <div className="workspace-empty">loading…</div>
  if (presets.length === 0) return <div className="workspace-empty">no presets saved</div>

  return (
    <div className="presets-panel">
      {error && <div className="presets-error">{error}</div>}
      {presets.map((p) => {
        const isOpen = expanded === p.name
        const cloud = p.personas.some((pp) => pp.model && !pp.model.startsWith("local/"))
        return (
          <div key={p.name} className={`preset-card${isOpen ? " open" : ""}`}>
            <button
              className="preset-card-head"
              onClick={() => setExpanded(isOpen ? null : p.name)}
              title={isOpen ? "Collapse" : "Show members"}
            >
              <span className="preset-card-caret">{isOpen ? "▾" : "▸"}</span>
              <span className="preset-card-name">{p.name}</span>
              <span className="preset-card-count">{p.personas.length}</span>
              {cloud && <span className="preset-card-cloud" title="Uses cloud models">☁</span>}
            </button>

            {isOpen && (
              <div className="preset-members">
                {p.personas.map((m) => (
                  <div key={m.id} className={`preset-member${m.active === false ? " inactive" : ""}`}>
                    <span className="pm-icon" style={{ color: m.color }}>{m.icon}</span>
                    <div className="pm-body">
                      <div className="pm-line1">
                        <span className="pm-name">{m.name}</span>
                        {m.parallel && <span className="pm-badge" title="Runs in parallel waves">∥</span>}
                        {m.active === false && <span className="pm-badge off">off</span>}
                      </div>
                      <div className="pm-line2">
                        <span className="pm-model" title={m.model ?? "default model"}>{modelLabel(m)}</span>
                        {m.thinkingLevel && <span className="pm-think">· think {m.thinkingLevel}</span>}
                      </div>
                      {m.tools.length > 0 && (
                        <div className="pm-tools">
                          {m.tools.map((t) => (
                            <span key={t} className="pm-tool">{t}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                <div className="preset-card-actions">
                  <button
                    className="mini"
                    disabled={turnActive || busy !== null}
                    onClick={() => act(p.name, "load")}
                    title="Load as a new discussion"
                  >
                    {busy === `load:${p.name}` ? "…" : "▶ load"}
                  </button>
                  <button
                    className="mini"
                    disabled={turnActive || busy !== null}
                    onClick={() => act(p.name, "apply")}
                    title="Apply to the current room in place"
                  >
                    {busy === `apply:${p.name}` ? "…" : "↻ apply"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
