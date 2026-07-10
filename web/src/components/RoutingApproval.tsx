import { useState } from "react"
import type { RosterItem, RouteDecision, RouteProposal } from "../types"

interface Props {
  proposals: RouteProposal[]
  roster: RosterItem[]
  onResolve: (decision: RouteDecision) => void
}

/** An agent rendered with its roster identity (icon + name in its color) —
 *  the card used to show bare "@id → @id" text, which read as debug output. */
function AgentChip({ id, roster }: { id: string; roster: RosterItem[] }) {
  const r = roster.find((x) => x.id === id)
  return (
    <span className="route-agent" style={r?.color ? { color: r.color } : undefined} title={`@${id}`}>
      {r?.icon && <span className="route-agent-icon">{r.icon}</span>}
      {r?.name ?? `@${id}`}
    </span>
  )
}

/** Approval card for a paused handoff (semi/manual routing). The human approves
 *  the proposed agent(s), redirects to someone else, or drops the handoff. */
export function RoutingApproval({ proposals, roster, onResolve }: Props) {
  const [redirecting, setRedirecting] = useState(false)
  const [target, setTarget] = useState("")

  // The proposer(s) make no sense as a redirect target — handing the turn
  // back to whoever just ended it is what "drop" already does.
  const proposers = new Set(proposals.map((p) => p.from))

  if (redirecting) {
    return (
      <div className="route-approval">
        <span className="route-label">↪ Redirect to</span>
        <select className="route-select" value={target} onChange={(e) => setTarget(e.target.value)} autoFocus>
          <option value="">choose an agent…</option>
          {roster
            .filter((r) => r.active && !proposers.has(r.id))
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.icon} {r.name}
              </option>
            ))}
        </select>
        <button
          className="route-btn approve"
          disabled={!target}
          onClick={() => onResolve({ action: "redirect", targetIds: [target] })}
        >
          Send
        </button>
        <button className="route-btn ghost" onClick={() => setRedirecting(false)}>
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="route-approval">
      <span className="route-pause-icon">⏸</span>
      <span className="route-label">
        Handoff{proposals.length > 1 ? "s" : ""} awaiting approval
      </span>
      <span className="route-hops">
        {proposals.map((p, i) => (
          <span key={i} className="route-hop">
            <AgentChip id={p.from} roster={roster} />
            <span className="route-arrow">→</span>
            <AgentChip id={p.target} roster={roster} />
          </span>
        ))}
      </span>
      <span className="route-actions">
        <button className="route-btn approve" onClick={() => onResolve({ action: "approve" })}>
          ✓ Approve
        </button>
        <button className="route-btn" onClick={() => setRedirecting(true)}>
          ↪ Redirect
        </button>
        <button className="route-btn drop" onClick={() => onResolve({ action: "drop" })}>
          ✕ Drop
        </button>
      </span>
    </div>
  )
}
