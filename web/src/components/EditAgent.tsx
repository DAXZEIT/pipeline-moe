import { useEffect, useState } from "react"
import { api } from "../api"
import type { ModelInfo, RosterItem } from "../types"

const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "web_read", "youtube_transcript", "arxiv_search", "youcom_search"]

interface Props {
  agent: RosterItem
  onCancel: () => void
  onSaved: () => void
}

/** Edit an existing agent's persona. Saving recreates its pi session, so the
 *  new prompt/tools take effect immediately (its identity is rebuilt). */
export function EditAgent({ agent, onCancel, onSaved }: Props) {
  const [name, setName] = useState(agent.name)
  const [systemPrompt, setSystemPrompt] = useState("")
  const [tools, setTools] = useState<string[]>(agent.tools)
  const [color, setColor] = useState(agent.color)
  const [icon, setIcon] = useState(agent.icon)
  const [model, setModel] = useState(agent.model ?? "")
  const [thinkingLevel, setThinkingLevel] = useState(agent.thinkingLevel ?? "")
  const [compactionInstructions, setCompactionInstructions] = useState("")
  const [availableThinkingLevels, setAvailableThinkingLevels] = useState<string[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [allowCloud, setAllowCloud] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  // Roster items don't carry the system prompt — fetch the full persona.
  useEffect(() => {
    let cancelled = false
    api
      .participant(agent.id)
      .then((p) => {
        if (cancelled) return
        setSystemPrompt(p.systemPrompt)
        setName(p.name)
        setTools(p.tools)
        setColor(p.color)
        setIcon(p.icon)
        setModel(p.model ?? "")
        setThinkingLevel(p.thinkingLevel ?? "")
        setCompactionInstructions(p.compactionInstructions ?? "")
        setAvailableThinkingLevels(p.availableThinkingLevels ?? [])
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
    return () => {
      cancelled = true
    }
  }, [agent.id])

  // Models offered for per-agent selection (local-only unless cloud enabled).
  useEffect(() => {
    let cancelled = false
    api
      .models()
      .then((r) => {
        if (cancelled) return
        setModels(r.models)
        setAllowCloud(r.allowCloud)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = (t: string) =>
    setTools((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]))

  return (
    <div className="create-agent">
      <div className="ca-editing">Editing @{agent.id}</div>
      <input
        className="ca-input"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="ca-row">
        <input
          className="ca-input ca-icon"
          value={icon}
          onChange={(e) => setIcon(e.target.value)}
          title="Emoji"
        />
        <input
          className="ca-input ca-color"
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          title="Color"
        />
      </div>
      <textarea
        className="ca-input"
        rows={6}
        placeholder={loaded ? "System prompt" : "loading…"}
        value={systemPrompt}
        onChange={(e) => setSystemPrompt(e.target.value)}
      />
      <div className="ca-tools">
        {ALL_TOOLS.map((t) => (
          <label key={t} className={`chip ${tools.includes(t) ? "on" : ""}`}>
            <input type="checkbox" checked={tools.includes(t)} onChange={() => toggle(t)} />
            {t}
          </label>
        ))}
      </div>
      <textarea
        className="ca-input"
        rows={3}
        placeholder="Compaction instructions (what to preserve vs discard — optional, max 500 chars)"
        value={compactionInstructions}
        onChange={(e) => setCompactionInstructions(e.target.value)}
        maxLength={500}
      />
      <label className="ca-model-label">
        model
        <select className="ca-input ca-model" value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">default (process model)</option>
          {models.map((m) => (
            <option key={m.ref} value={m.ref}>
              {m.local ? "🖥 " : "☁ "}
              {m.name} — {m.provider}
            </option>
          ))}
          {model && !models.some((m) => m.ref === model) && (
            <option value={model}>⚠ {model} (unavailable)</option>
          )}
        </select>
      </label>
      {!allowCloud && (
        <div className="ca-model-hint">local-only — cloud models hidden (PIPELINE_ALLOW_CLOUD)</div>
      )}
      <label className="ca-model-label">
        thinking level
        <select className="ca-input ca-model" value={thinkingLevel} onChange={(e) => setThinkingLevel(e.target.value)}>
          <option value="">default (inherit from PIPELINE_THINKING)</option>
          {(availableThinkingLevels.length > 0 ? availableThinkingLevels : ["off", "minimal", "low", "medium", "high", "xhigh"]).map((level) => (
            <option key={level} value={level}>{level}</option>
          ))}
        </select>
      </label>
      <div className="ca-actions">
        <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn btn-send"
          disabled={busy || !loaded || !name.trim() || !systemPrompt.trim()}
          onClick={async () => {
            setBusy(true)
            try {
              await api.updateAgent(agent.id, {
                name: name.trim(),
                systemPrompt: systemPrompt.trim(),
                tools,
                color,
                icon,
                model: model || null, // "" → null clears back to the default
                thinkingLevel: thinkingLevel || null,
                compactionInstructions: compactionInstructions || null,
              })
              onSaved()
            } catch {
              setBusy(false)
            }
          }}
        >
          {busy ? "…" : "Save"}
        </button>
      </div>
    </div>
  )
}
