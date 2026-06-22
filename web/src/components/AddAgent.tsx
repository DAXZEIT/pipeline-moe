import { useEffect, useState } from "react"
import { api } from "../api"
import type { PersonaTemplate } from "../types"
import { CreateAgent } from "./CreateAgent"

interface Props {
  onCancel: () => void
  onCreate: (body: Parameters<typeof api.create>[0]) => Promise<void>
  onAddTemplate: (templateId: string) => Promise<void>
}

function modelLabel(model?: string): string {
  if (!model) return "default model"
  const id = model.split("/").pop()?.replace(/\.gguf$/, "") ?? model
  return (model.startsWith("local/") ? "🖥 " : "☁ ") + id
}

/** Add-agent flow: pick a built-in persona template to clone (e.g. a second
 *  builder) — no need to load a preset and prune it — or switch to the custom
 *  from-scratch form. */
export function AddAgent({ onCancel, onCreate, onAddTemplate }: Props) {
  const [mode, setMode] = useState<"pick" | "custom">("pick")
  const [templates, setTemplates] = useState<PersonaTemplate[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    api.personaTemplates().then(setTemplates).catch(() => setTemplates([]))
  }, [])

  if (mode === "custom") {
    return <CreateAgent onCancel={() => setMode("pick")} onCreate={onCreate} />
  }

  const add = async (id: string) => {
    setBusyId(id)
    try {
      await onAddTemplate(id)
    } catch {
      setBusyId(null) // parent closes the panel on success; reset only on error
    }
  }

  return (
    <div className="add-agent">
      <div className="add-agent-head">Add an agent</div>
      <div className="add-agent-list">
        {templates === null && <div className="add-agent-empty">loading…</div>}
        {templates?.map((t) => (
          <button
            key={t.id}
            className="add-agent-item"
            disabled={busyId !== null}
            onClick={() => add(t.id)}
            title={`Add a copy of ${t.name}`}
          >
            <span className="aa-icon" style={{ background: `${t.color}22`, color: t.color }}>
              {t.icon}
            </span>
            <span className="aa-body">
              <span className="aa-name">{t.name}</span>
              <span className="aa-meta">{modelLabel(t.model)} · {t.tools.length} tools</span>
            </span>
            <span className="aa-add">{busyId === t.id ? "…" : "+"}</span>
          </button>
        ))}
      </div>
      <button className="add-agent-custom" onClick={() => setMode("custom")}>
        ✏ Custom agent…
      </button>
      <div className="ca-actions">
        <button className="btn btn-ghost" onClick={onCancel} disabled={busyId !== null}>
          Cancel
        </button>
      </div>
    </div>
  )
}
