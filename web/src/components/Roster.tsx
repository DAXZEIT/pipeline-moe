import { useState } from "react"
import { api } from "../api"
import { groupBySeat, seatMoves } from "@pipeline-moe/client-core"
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
  /** Preset provenance + drift. null when the room isn't from a preset. The
   *  `*` (modified-buffer style) shows when the live roster deviates. */
  drift?: { preset: string; deviates: boolean } | null
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
  /** Send a text message (slash commands) through the room. */
  onSend: (text: string) => void
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
  drift,
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
  onSend,
}: Props) {
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [seatPrompt, setSeatPrompt] = useState<{ partnerId: string; creatorId: string; name: string; error?: string } | null>(null)

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
        {drift ? (
          <div
            className="roster-preset"
            title={
              drift.deviates
                ? `Live roster deviates from preset "${drift.preset}" — use the 🎯 preset menu to Restore or Save to preset`
                : `From preset "${drift.preset}"`
            }
          >
            preset:{drift.preset}
            {drift.deviates ? <span className="roster-preset-drift">*</span> : null}
          </div>
        ) : null}
      </div>

      <div className="roster-list">
        {(() => {
          // Fused seats: members sharing a seat render as ONE group — label +
          // a single context gauge (the values cannot diverge: one session
          // behind every hat). groupBySeat normalizes scattered wire order
          // (pre-fix persisted rosters, drags); singletons render as before.
          const runs: { seat?: string; items: RosterItem[] }[] = []
          for (const r of groupBySeat(roster)) {
            const last = runs[runs.length - 1]
            if (last && last.seat !== undefined && r.seat === last.seat) last.items.push(r)
            else runs.push({ seat: r.seat, items: [r] })
          }
          return runs.map((run) =>
            run.items.length === 1 ? (
              renderItem(run.items[0], false)
            ) : (
              <div className="seat-group" key={`seat-${run.seat}`}>
                <div className="seat-label" title="These agents share one working context (fused seat)">
                  ⌐ {run.seat} seat · shared context
                </div>
                {run.items.map((r) => renderItem(r, true))}
                {(() => {
                  const carrier = run.items.find((r) => r.contextUsage) ?? run.items[0]
                  return (
                    <div className="seat-gauge">
                      {carrier.contextUsage && (
                        <div className={`ctx-bar ${carrier.contextUsage.percent !== null && carrier.contextUsage.percent > 80 ? "ctx-warning" : ""}`}>
                          <div className="ctx-fill-wrap">
                            <div
                              className={`ctx-fill ${ctxColor(carrier.contextUsage.percent)}`}
                              style={{ width: `${carrier.contextUsage.percent !== null ? carrier.contextUsage.percent : 0}%` }}
                            />
                          </div>
                          <span className="ctx-label">{ctxLabel(carrier.contextUsage)}</span>
                        </div>
                      )}
                      {carrier.sessionStats && (
                        <div className="session-stats">{statsLabel(carrier.sessionStats)}</div>
                      )}
                    </div>
                  )
                })()}
              </div>
            ),
          )
        })()}
      </div>

      {/* Seat-name prompt — „Share a seat with…" — fixed overlay to escape
       *  the roster scroll container, same placement strategy as AgentMenu. */}
      {seatPrompt && (
        <div className="seat-prompt-overlay" onClick={() => setSeatPrompt(null)}>
          <div className="seat-prompt" onClick={(e) => e.stopPropagation()}>
            <div className="seat-prompt-title">Name the seat for {seatPrompt.name || "…"}</div>
            <div className="seat-prompt-subtitle">@{seatPrompt.creatorId} + @{seatPrompt.partnerId}</div>
            <input
              autoFocus
              className="seat-prompt-input"
              value={seatPrompt.name}
              placeholder="e.g. maker"
              onChange={(e) => setSeatPrompt((p) => p ? { ...p, name: e.target.value, error: undefined } : null)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  confirmSeatPrompt()
                }
                if (e.key === "Escape") setSeatPrompt(null)
              }}
            />
            <div className="seat-prompt-actions">
              <button className="btn btn-ghost" onClick={() => setSeatPrompt(null)}>Cancel</button>
              <button className="btn" onClick={() => confirmSeatPrompt()}>Create seat</button>
            </div>
            {seatPrompt.error && (
              <div className="seat-prompt-error">{seatPrompt.error}</div>
            )}
          </div>
        </div>
      )}

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

  /** One roster row (+ its inline editor). `inSeatGroup` suppresses the
   *  per-agent gauge/stats — the group renders the seat's single gauge. */
  function renderItem(r: RosterItem, inSeatGroup: boolean) {
          function openSeatPrompt(partnerId: string) {
            setSeatPrompt({ partnerId, creatorId: r.id, name: "", error: undefined })
          }
          const seatItems = seatMenuItems(r, roster, turnActive, onSend, openSeatPrompt)
          const menuItems: AgentMenuItem[] = [
            { icon: "✏", label: editingId === r.id ? "Close editor" : "Edit persona", disabled: turnActive, onClick: () => setEditingId((cur) => (cur === r.id ? null : r.id)) },
            { icon: "★", label: r.id === explicit ? "Clear default" : "Set as default", checked: r.id === effective, disabled: !r.active, onClick: () => onSetDefault(r.id === explicit ? null : r.id) },
            { icon: "∥", label: "Run in parallel", checked: r.parallel, onClick: () => onSetParallel(r.id, !r.parallel) },
            { icon: "👁", label: "Vision (image input)", checked: r.vision !== false, onClick: () => onSetVision(r.id, r.vision === false) },
            { icon: r.active ? "◐" : "○", label: r.active ? "Deactivate" : "Activate", onClick: () => onSetActive(r.id, !r.active) },
            { icon: "⟳", label: "Compact context", disabled: turnActive || r.status === "compacting", onClick: () => onCompact(r.id) },
            { icon: "⬇", label: "Export HTML", onClick: () => void downloadAgent(r.id, "html") },
            { icon: "⬇", label: "Export JSONL", onClick: () => void downloadAgent(r.id, "jsonl") },
            ...seatItems,
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
                {!inSeatGroup && r.contextUsage && (
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
                {!inSeatGroup && r.sessionStats && (
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
  }

  /** Seat names travel through the same slug discipline as the server's ids. */
  function slugSeat(s: string): string {
    return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  }

  /** Seat actions for the roster ⋯ menu: join a fused seat, share a new seat
   *  with an own-context peer (opens the name prompt), detach. Model
   *  mismatches are shown with ⚠ but not hidden — the server refuses loudly
   *  and the hint explains the fix before the user hits it. Mirrors the TUI's
   *  seatActionItems logic (seats-menu.ts) so the two clients stay in lockstep. */
  function seatMenuItems(
    agent: RosterItem,
    roster: RosterItem[],
    turnActive: boolean,
    onSend: (text: string) => void,
    startPair: (partnerId: string) => void,
  ): AgentMenuItem[] {
    const { joins, pairs, canDetach } = seatMoves(agent, roster)
    const items: AgentMenuItem[] = []
    for (const j of joins) {
      items.push({
        icon: "⇥",
        label: `Join ⌐${j.seat}${j.mismatch ? " ⚠" : ""}`,
        hint: `${j.hats.map((h) => `@${h.id}`).join(" + ")}${j.mismatch ? " · different model — the server will refuse" : ""}`,
        disabled: turnActive,
        onClick: () => onSend(`/seats fuse ${j.seat} ${j.hats.map((h) => `@${h.id}`).join(" ")}`),
      })
    }
    for (const pr of pairs) {
      items.push({
        icon: "⧉",
        label: `Share a seat with ${pr.partner.icon} ${pr.partner.name}…${pr.mismatch ? " ⚠" : ""}`,
        hint: `you name the seat${pr.mismatch ? " · different model — the server will refuse" : ""}`,
        disabled: turnActive,
        onClick: () => startPair(pr.partner.id),
      })
    }
    if (canDetach) {
      items.push({
        icon: "⏏",
        label: "Detach to own context",
        hint: "fresh session — the shared one stays with the seat",
        disabled: turnActive,
        onClick: () => onSend(`/seats solo @${agent.id}`),
      })
    }
    if (items.length > 0) items[0].separatorBefore = true
    return items
  }

  /** Confirm the seat-name prompt: slug the name, fire the fuse command. */
  function confirmSeatPrompt(): void {
    if (!seatPrompt) return
    const slug = slugSeat(seatPrompt.name)
    if (!slug) {
      setSeatPrompt({ ...seatPrompt, error: "Seat name must contain at least one of [a-z0-9]." })
      return
    }
    onSend(`/seats fuse ${slug} @${seatPrompt.creatorId} @${seatPrompt.partnerId}`)
    setSeatPrompt(null)
  }
}
