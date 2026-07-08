import { useState } from "react"
import { api } from "../api"
import type { PersonaDetail, RosterItem } from "../types"
import { AddAgent } from "./AddAgent"
import { AgentMenu, type AgentMenuItem } from "./AgentMenu"
import { EditAgent } from "./EditAgent"

/** Download an agent's session export (HTML or JSONL) as a file. */
async function downloadAgent(id: string, kind: "html" | "jsonl"): Promise<void> {
  const blob = kind === "html" ? await api.exportAgent(id) : await api.exportAgentJsonl(id)
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `${id}.${kind}`
  a.click()
  URL.revokeObjectURL(url)
}

interface Props {
  roster: RosterItem[]
  connected: boolean
  defaultAgent: string | null
  turnActive: boolean
  onSetActive: (id: string, active: boolean) => void
  onSetParallel: (id: string, parallel: boolean) => void
  onSetVision: (id: string, vision: boolean) => void
  onSetDefault: (id: string | null) => void
  onKick: (id: string) => void
  onCompact: (id: string) => void
  onCreate: (body: Parameters<typeof api.create>[0]) => Promise<unknown>
  onAddTemplate: (templateId: string) => Promise<unknown>
  onReorder: (order: string[]) => void
  onFetchParticipant: (id: string) => Promise<PersonaDetail>
  onUpdate: (id: string, patch: Parameters<typeof api.updateAgent>[1]) => Promise<unknown>
}

/** Move `from` relative to `to`: dragging down lands below the target, dragging
 *  up lands above it — the natural feel for a vertical list. */
function reorderIds(ids: string[], from: string, to: string): string[] {
  const fromIdx = ids.indexOf(from)
  const toIdx = ids.indexOf(to)
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return ids
  const out = [...ids]
  out.splice(fromIdx, 1)
  const insertIdx = out.indexOf(to) + (fromIdx < toIdx ? 1 : 0)
  out.splice(insertIdx, 0, from)
  return out
}

const STATUS_LABEL: Record<RosterItem["status"], string> = {
  idle: "idle",
  active: "active",
  thinking: "thinking",
  working: "working",
  compacting: "compacting…",
  retrying: "retrying…",
}

/** Color threshold: green <50, yellow 50-75, orange 75-90, red >90 (inclusive boundaries) */
function ctxColor(pct: number | null): string {
  if (pct == null) return "ctx-green"
  if (pct >= 90) return "ctx-red"
  if (pct >= 75) return "ctx-orange"
  if (pct >= 50) return "ctx-yellow"
  return "ctx-green"
}

/** Compact label: "42K / 128K" or "— / 128K" when tokens unknown */
function ctxLabel(usage: { tokens: number | null; contextWindow: number; percent: number | null }): string {
  const t = usage.tokens != null ? `${Math.round(usage.tokens / 1000)}K` : "—"
  const w = `${Math.round(usage.contextWindow / 1000)}K`
  return `${t} / ${w}`
}

/** Compact number format: 42000 → "42K", 1200 → "1.2K" */
function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`
  return String(n)
}

/** Session stats label: "in 38K · out 1.2K · cache 92%" */
function statsLabel(s: { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; toolCalls: number }): string {
  const { input, output, cacheRead, total } = s.tokens
  const cachePct = total > 0 ? Math.round((cacheRead / total) * 100) : 0
  return `${fmt(input)}i · ${fmt(output)}o · cache ${cachePct}% · ${s.toolCalls} tools`
}

export function Roster({
  roster,
  connected,
  defaultAgent,
  turnActive,
  onSetActive,
  onSetParallel,
  onSetVision,
  onSetDefault,
  onKick,
  onCompact,
  onCreate,
  onAddTemplate,
  onReorder,
  onFetchParticipant,
  onUpdate,
}: Props) {
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const drop = (targetId: string) => {
    if (dragId && dragId !== targetId) {
      onReorder(reorderIds(roster.map((r) => r.id), dragId, targetId))
    }
    setDragId(null)
    setOverId(null)
  }
  const actives = roster.filter((r) => r.active)
  const activeCount = actives.length

  // The explicitly-pinned default (if still active), else the first active agent
  // is the implicit fallback. We mark the effective one with a star.
  const explicit = defaultAgent && actives.some((r) => r.id === defaultAgent) ? defaultAgent : null
  const effective = explicit ?? actives[0]?.id ?? null

  return (
    <aside className="roster">
      <div className="roster-head">
        <div className="roster-title">Pipeline-MoE</div>
        <div className="roster-sub">
          <span className={`dot ${connected ? "dot-on" : "dot-off"}`} />
          roster {activeCount}/{roster.length}
        </div>
      </div>

      <div className="roster-list">
        {roster.map((r) => {
          const menuItems: AgentMenuItem[] = [
            { icon: "✏", label: editingId === r.id ? "Close editor" : "Edit persona", disabled: turnActive, onClick: () => setEditingId((cur) => (cur === r.id ? null : r.id)) },
            { icon: "★", label: r.id === explicit ? "Clear default" : "Set as default", checked: r.id === effective, disabled: !r.active, onClick: () => onSetDefault(r.id === explicit ? null : r.id) },
            { icon: "∥", label: "Run in parallel", checked: r.parallel, onClick: () => onSetParallel(r.id, !r.parallel) },
            { icon: "👁", label: "Vision (image input)", checked: r.vision !== false, onClick: () => onSetVision(r.id, r.vision === false) },
            { icon: r.active ? "◐" : "○", label: r.active ? "Deactivate" : "Activate", onClick: () => onSetActive(r.id, !r.active) },
            { icon: "⟳", label: "Compact context", disabled: turnActive || r.status === "compacting", onClick: () => onCompact(r.id) },
            { icon: "⬇", label: "Export HTML", onClick: () => void downloadAgent(r.id, "html") },
            { icon: "⬇", label: "Export JSONL", onClick: () => void downloadAgent(r.id, "jsonl") },
            { icon: "🗑", label: "Kick from room", danger: true, separatorBefore: true, onClick: () => onKick(r.id) },
          ]
          return (
          <div key={r.id}>
            <div
              className={`roster-item ${r.active ? "" : "inactive"} ${editingId === r.id ? "editing" : ""} ${dragId === r.id ? "dragging" : ""} ${overId === r.id ? "drag-over" : ""}`}
              onDragOver={(e) => {
                if (!dragId || dragId === r.id) return
                e.preventDefault()
                setOverId(r.id)
              }}
              onDrop={(e) => {
                e.preventDefault()
                drop(r.id)
              }}
            >
              <span
                className="drag-handle"
                draggable
                title="Drag to reorder the first-turn / @all order"
                onDragStart={(e) => {
                  setDragId(r.id)
                  e.dataTransfer.effectAllowed = "move"
                }}
                onDragEnd={() => {
                  setDragId(null)
                  setOverId(null)
                }}
              >
                ⠿
              </span>
              <span className="avatar" style={{ background: `${r.color}22`, color: r.color }}>
                {r.icon}
              </span>
              <div className="roster-meta">
                <div className="roster-top">
                  <button
                    className="roster-name-btn"
                    title={turnActive ? "Stop the turn to edit" : "Edit persona / system prompt"}
                    onClick={() => { if (!turnActive) setEditingId((cur) => (cur === r.id ? null : r.id)) }}
                  >
                    <span className="roster-name" style={{ color: r.active ? r.color : undefined }}>
                      {r.name}
                    </span>
                    {r.id === effective && (
                      <span className="badge-default" title="Default for un-mentioned messages">★</span>
                    )}
                    {r.parallel && (
                      <span className="badge-parallel" title="Runs in parallel">∥</span>
                    )}
                    {r.vision === false && (
                      <span className="badge-no-vision" title="No vision — images are not sent to this agent">🚫👁</span>
                    )}
                  </button>
                  <AgentMenu items={menuItems} />
                </div>
                <div className={`roster-status status-${r.status}`}>
                  {STATUS_LABEL[r.status]}
                  {r.status === "retrying" && r.retry && (
                    <span className="retry-info">
                      ({r.retry.attempt}/{r.retry.maxAttempts} — {r.retry.errorMessage})
                    </span>
                  )}
                </div>
                {r.model && (
                  <span
                    className={`roster-model ${r.model.startsWith("local/") ? "" : "cloud"}`}
                    title={r.model}
                  >
                    {r.model.startsWith("local/") ? "🖥 " : "☁ "}
                    {r.model.split("/").pop()?.replace(/\.gguf$/, "")}
                  </span>
                )}
                {r.contextUsage && (
                  <div className={`ctx-bar ${r.contextUsage.percent !== null && r.contextUsage.percent > 80 ? "ctx-warning" : ""}`}>
                    <div className="ctx-fill-wrap">
                      <div
                        className={`ctx-fill ${ctxColor(r.contextUsage.percent)}`}
                        style={{ width: `${r.contextUsage.percent !== null ? r.contextUsage.percent : 0}%` }}
                      />
                    </div>
                    <span className="ctx-label">
                      {ctxLabel(r.contextUsage)}
                    </span>
                  </div>
                )}
                {r.sessionStats && (
                  <div className="session-stats" title={`Input: ${r.sessionStats.tokens.input} · Output: ${r.sessionStats.tokens.output} · Cache read: ${r.sessionStats.tokens.cacheRead} · Cache write: ${r.sessionStats.tokens.cacheWrite}`}>
                    {statsLabel(r.sessionStats)}
                  </div>
                )}
              </div>
            </div>
            {editingId === r.id && (
              <EditAgent
                agent={r}
                onFetch={onFetchParticipant}
                onSave={onUpdate}
                onCancel={() => setEditingId(null)}
                onSaved={() => setEditingId(null)}
              />
            )}
          </div>
          )
        })}
      </div>

      <div className="roster-foot">
        {creating ? (
          <AddAgent
            onCancel={() => setCreating(false)}
            onCreate={async (body) => {
              await onCreate(body)
              setCreating(false)
            }}
            onAddTemplate={async (id) => {
              await onAddTemplate(id)
              setCreating(false)
            }}
          />
        ) : (
          <button className="btn btn-ghost full" onClick={() => setCreating(true)}>
            + Add agent
          </button>
        )}
      </div>
    </aside>
  )
}
