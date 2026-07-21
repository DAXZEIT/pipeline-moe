import { useMemo, useState } from "react"
import type { Message, RosterItem } from "../types"
import {
  deriveHandoffGraph,
  dominantType,
  USER_NODE,
  type HandoffEdge,
  type HandoffType,
} from "../handoffs"

const TYPE_CLASS: Record<HandoffType, string> = {
  handoff: "hg-handoff",
  route: "hg-route",
  hatswitch: "hg-hatswitch",
}

interface Props {
  messages: Message[]
  roster: RosterItem[]
  /** Which view opens first; the toggle switches freely after. */
  initialView?: "radial" | "matrix"
}

/**
 * Room-level handoff graph: who passes the turn to whom, over the current
 * conversation. Radial flow is the default read; the matrix is the exact-count
 * inspect view behind a toggle. Both are pure functions of the live transcript
 * + roster, so they update as the room works.
 */
export function HandoffGraph({ messages, roster, initialView = "radial" }: Props) {
  const graph = useMemo(() => deriveHandoffGraph(messages, roster), [messages, roster])
  const [view, setView] = useState<"radial" | "matrix">(initialView)

  if (graph.edges.length === 0) {
    return (
      <div className="hg-empty">
        No handoffs yet — the graph draws itself as seats pass the turn.
      </div>
    )
  }

  return (
    <div className="hg">
      <div className="hg-head">
        <div className="hg-toggle">
          <button className={`hg-tab${view === "radial" ? " on" : ""}`} onClick={() => setView("radial")}>
            Flow
          </button>
          <button className={`hg-tab${view === "matrix" ? " on" : ""}`} onClick={() => setView("matrix")}>
            Matrix
          </button>
        </div>
        <span className="hg-count">{graph.total} handoffs</span>
      </div>
      {view === "radial" ? <Radial graph={graph} /> : <Matrix graph={graph} />}
      <div className="hg-legend">
        <span className="hg-key"><i className="hg-swatch hg-handoff" />handoff</span>
        <span className="hg-key"><i className="hg-swatch hg-route" />you route in</span>
        <span className="hg-key"><i className="hg-swatch hg-hatswitch" />hat switch</span>
      </div>
    </div>
  )
}

// ── Radial flow ────────────────────────────────────────────────────────────

const W = 340
const H = 340
const CX = W / 2
const CY = H / 2
// Horizontal breathing room so side labels ("Auditor ↑0 ↓5") never clip the
// viewBox edge. Symmetric, so the ring stays centred on CX.
const PAD = 46

function Radial({ graph }: { graph: ReturnType<typeof deriveHandoffGraph> }) {
  const [hover, setHover] = useState<string | null>(null)
  // Busiest seats first gives a stable, legible ring order.
  const nodes = useMemo(
    () => [...graph.nodes].sort((a, b) => b.turns - a.turns || a.id.localeCompare(b.id)),
    [graph.nodes],
  )
  const R = Math.min(W, H) * 0.3
  const pos = useMemo(() => {
    const p: Record<string, { x: number; y: number }> = {}
    nodes.forEach((n, i) => {
      const a = -Math.PI / 2 + (i / nodes.length) * Math.PI * 2
      p[n.id] = { x: CX + Math.cos(a) * R, y: CY + Math.sin(a) * R }
    })
    return p
  }, [nodes, R])
  const maxC = Math.max(...graph.edges.map((e) => e.count))
  const outByNode: Record<string, number> = {}
  const inByNode: Record<string, number> = {}
  for (const e of graph.edges) {
    outByNode[e.source] = (outByNode[e.source] ?? 0) + e.count
    inByNode[e.target] = (inByNode[e.target] ?? 0) + e.count
  }
  const touchesHover = (e: HandoffEdge): boolean =>
    hover === null || e.source === hover || e.target === hover

  return (
    <svg className="hg-svg" viewBox={`${-PAD} 0 ${W + PAD * 2} ${H}`} role="img" aria-label="Handoff flow graph">
      {graph.edges.map((e) => {
        const s = pos[e.source]
        const t = pos[e.target]
        if (!s || !t) return null
        // Bend each arc toward the centre so A→B and B→A stay separable.
        const mx = (s.x + t.x) / 2
        const my = (s.y + t.y) / 2
        const qx = CX + (mx - CX) * 0.55
        const qy = CY + (my - CY) * 0.55
        return (
          <path
            key={`${e.source}>${e.target}`}
            className={`hg-edge ${TYPE_CLASS[dominantType(e)]}`}
            d={`M${s.x},${s.y} Q${qx},${qy} ${t.x},${t.y}`}
            strokeWidth={1 + (e.count / maxC) * 6}
            opacity={touchesHover(e) ? 0.55 : 0.07}
          >
            <title>{`${e.source} → ${e.target} · ×${e.count}`}</title>
          </path>
        )
      })}
      {nodes.map((n) => {
        const p = pos[n.id]
        if (!p) return null
        const r = 13 + Math.sqrt(n.turns) * 2.6
        const side = p.x < CX ? -1 : 1
        const anchor = side < 0 ? "end" : "start"
        const out = outByNode[n.id] ?? 0
        const inc = inByNode[n.id] ?? 0
        return (
          <g
            key={n.id}
            transform={`translate(${p.x},${p.y})`}
            className="hg-node"
            onPointerEnter={() => setHover(n.id)}
            onPointerLeave={() => setHover(null)}
          >
            <circle r={r} fill={n.color} stroke="var(--hg-surface, #fff)" strokeWidth={2.5} fillOpacity={0.92} />
            <text className="hg-node-icon" textAnchor="middle" dy={r * 0.34} fontSize={r * 0.9}>
              {n.icon}
            </text>
            <text className="hg-node-label" textAnchor={anchor} x={side * (r + 6)} dy={-1}>
              {n.name}
            </text>
            <text className="hg-node-sub" textAnchor={anchor} x={side * (r + 6)} dy={11}>
              {n.id === USER_NODE ? `↑${out}` : `↑${out} ↓${inc}`}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// ── Flow matrix ──────────────────────────────────────────────────────────────

function Matrix({ graph }: { graph: ReturnType<typeof deriveHandoffGraph> }) {
  const nodes = [...graph.nodes].sort((a, b) => b.turns - a.turns || a.id.localeCompare(b.id))
  const cell = new Map<string, HandoffEdge>()
  for (const e of graph.edges) cell.set(`${e.source}>${e.target}`, e)
  const maxC = Math.max(...graph.edges.map((e) => e.count))
  const rowTot = (id: string): number =>
    nodes.reduce((sum, t) => sum + (cell.get(`${id}>${t.id}`)?.count ?? 0), 0)
  const colTot = (id: string): number =>
    nodes.reduce((sum, s) => sum + (cell.get(`${s.id}>${id}`)?.count ?? 0), 0)

  return (
    <div className="hg-matrix-wrap">
      <table className="hg-matrix">
        <thead>
          <tr>
            <th className="hg-corner">↓ from · to →</th>
            {nodes.map((t) => (
              <th key={t.id} title={t.name}>{t.icon}</th>
            ))}
            <th className="hg-tot">Σ</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((s) => (
            <tr key={s.id}>
              <th title={s.name}>{s.icon} {s.name}</th>
              {nodes.map((t) => {
                const e = cell.get(`${s.id}>${t.id}`)
                if (!e) return <td key={t.id} />
                const a = 0.14 + (e.count / maxC) * 0.6
                return (
                  <td key={t.id}>
                    <span
                      className={`hg-cell ${TYPE_CLASS[dominantType(e)]}`}
                      style={{ opacity: a }}
                    />
                    <span className="hg-cell-n">{e.count}</span>
                  </td>
                )
              })}
              <td className="hg-tot">{rowTot(s.id)}</td>
            </tr>
          ))}
          <tr className="hg-foot">
            <th className="hg-tot">Σ in</th>
            {nodes.map((t) => (
              <td key={t.id} className="hg-tot">{colTot(t.id)}</td>
            ))}
            <td className="hg-tot" />
          </tr>
        </tbody>
      </table>
    </div>
  )
}
