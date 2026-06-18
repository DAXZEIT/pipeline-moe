import { useState } from "react"
import type { RosterItem } from "../types"
import { CreateAgent } from "./CreateAgent"
import { EditAgent } from "./EditAgent"
import type { api } from "../api"

interface Props {
  roster: RosterItem[]
  connected: boolean
  defaultAgent: string | null
  turnActive: boolean
  onSetActive: (id: string, active: boolean) => void
  onSetParallel: (id: string, parallel: boolean) => void
  onSetDefault: (id: string | null) => void
  onKick: (id: string) => void
  onCompact: (id: string) => void
  onCreate: (body: Parameters<typeof api.create>[0]) => Promise<unknown>
  onReorder: (order: string[]) => void
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

export function Roster({
  roster,
  connected,
  defaultAgent,
  turnActive,
  onSetActive,
  onSetParallel,
  onSetDefault,
  onKick,
  onCompact,
  onCreate,
  onReorder,
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
        <div className="roster-title">AGENT CHAT ROOM</div>
        <div className="roster-sub">
          <span className={`dot ${connected ? "dot-on" : "dot-off"}`} />
          roster {activeCount}/{roster.length}
        </div>
      </div>

      <div className="roster-list">
        {roster.map((r) => (
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
                <div className="roster-name" style={{ color: r.active ? r.color : undefined }}>
                  {r.name}
                </div>
                <div className={`roster-status status-${r.status}`}>
                  {STATUS_LABEL[r.status]}
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
                <div className="roster-actions">
                  <button
                    className={`mini ${r.id === effective ? "star-on" : ""}`}
                    disabled={!r.active}
                    title={
                      r.id === explicit
                        ? "Default for un-mentioned messages (click to clear)"
                        : r.id === effective
                          ? "Default (fallback: first active agent)"
                          : "Make default for un-mentioned messages"
                    }
                    onClick={() => onSetDefault(r.id === explicit ? null : r.id)}
                  >
                    {r.id === effective ? "★" : "☆"}
                  </button>
                  <button
                    className={`mini ${editingId === r.id ? "star-on" : ""}`}
                    disabled={turnActive}
                    title={turnActive ? "Stop the turn to edit" : "Edit persona / system prompt"}
                    onClick={() => setEditingId((cur) => (cur === r.id ? null : r.id))}
                  >
                    {"{}"}
                  </button>
                  <button
                    className={`mini ${r.parallel ? "par-on" : ""}`}
                    title={
                      r.parallel
                        ? "Runs in parallel with adjacent parallel agents (click to make serial)"
                        : "Run in parallel (local agents still serialize on the GPU)"
                    }
                    onClick={() => onSetParallel(r.id, !r.parallel)}
                  >
                    ∥
                  </button>
                  <button
                    className="mini"
                    disabled={turnActive || r.status === "compacting"}
                    title={r.status === "compacting" ? "Compacting…" : turnActive ? "Stop the turn first" : "Compact context (free tokens)"}
                    onClick={() => onCompact(r.id)}
                  >
                    ⟳
                  </button>
                  <button
                    className="mini"
                    title={r.active ? "Deactivate" : "Activate"}
                    onClick={() => onSetActive(r.id, !r.active)}
                  >
                    {r.active ? "◐" : "○"}
                  </button>
                  <button className="mini danger" title="Kick" onClick={() => onKick(r.id)}>
                    ×
                  </button>
                </div>
              </div>
            </div>
            {editingId === r.id && (
              <EditAgent
                agent={r}
                onCancel={() => setEditingId(null)}
                onSaved={() => setEditingId(null)}
              />
            )}
          </div>
        ))}
      </div>

      <div className="roster-foot">
        {creating ? (
          <CreateAgent
            onCancel={() => setCreating(false)}
            onCreate={async (body) => {
              await onCreate(body)
              setCreating(false)
            }}
          />
        ) : (
          <button className="btn btn-ghost full" onClick={() => setCreating(true)}>
            + New agent
          </button>
        )}
      </div>
    </aside>
  )
}
