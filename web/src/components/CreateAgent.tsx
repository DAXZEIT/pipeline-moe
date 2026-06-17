import { useState } from "react"
import type { api } from "../api"

const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"]

interface Props {
  onCancel: () => void
  onCreate: (body: Parameters<typeof api.create>[0]) => Promise<void>
}

export function CreateAgent({ onCancel, onCreate }: Props) {
  const [name, setName] = useState("")
  const [systemPrompt, setSystemPrompt] = useState("")
  const [tools, setTools] = useState<string[]>(["read", "grep", "find", "ls"])
  const [color, setColor] = useState("#6Fb3d2")
  const [icon, setIcon] = useState("🤖")
  const [busy, setBusy] = useState(false)

  const toggle = (t: string) =>
    setTools((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]))

  return (
    <div className="create-agent">
      <input
        className="ca-input"
        placeholder="Name (e.g. Reviewer)"
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
        rows={3}
        placeholder="System prompt — the persona's role and behavior"
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
      <div className="ca-actions">
        <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn btn-send"
          disabled={busy || !name.trim() || !systemPrompt.trim()}
          onClick={async () => {
            setBusy(true)
            try {
              await onCreate({ name: name.trim(), systemPrompt: systemPrompt.trim(), tools, color, icon })
            } catch {
              setBusy(false)
            }
          }}
        >
          {busy ? "…" : "Create"}
        </button>
      </div>
    </div>
  )
}
