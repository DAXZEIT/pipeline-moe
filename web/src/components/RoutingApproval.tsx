import { useState } from "react"
import type { RosterItem, RouteDecision, RouteProposal } from "../types"

interface Props {
  proposals: RouteProposal[]
  roster: RosterItem[]
  onResolve: (decision: RouteDecision) => void
}

/** Approval card for a paused handoff (semi/manual routing). The human approves
 *  the proposed agent(s), redirects to someone else, or drops the handoff. */
export function RoutingApproval({ proposals, roster, onResolve }: Props) {
  const [redirecting, setRedirecting] = useState(false)
  const [target, setTarget] = useState("")

  if (redirecting) {
    return (
      <div className="route-approval">
        <span className="route-label">↪ Redirect to</span>
        <select className="route-select" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">choose an agent…</option>
          {roster
            .filter((r) => r.active)
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
      <span className="route-label">
        Proposed handoff{proposals.length > 1 ? "s" : ""}:
      </span>
      <span className="route-hops">
        {proposals.map((p, i) => (
          <span key={i} className="route-hop">
            @{p.from} → <b>@{p.target}</b>
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
