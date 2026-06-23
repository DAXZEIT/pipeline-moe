import type { RosterItem } from "../types"

const THINKING_LEVELS: Array<"off" | "minimal" | "low" | "medium" | "high" | "xhigh"> = [
  "off", "minimal", "low", "medium", "high", "xhigh",
]

interface Props {
  roster: RosterItem[]
  defaultAgent: string | null
  fallbackAgent: string | null
  circuitBreaker: boolean
  defaultThinkingLevel: string
  allowCloud: boolean
  compactionReserveTokens: number
  maxChainHops: number
  maxRooms: number
  turnActive: boolean
  onSetDefaultAgent: (id: string | null) => void
  onSetFallbackAgent: (id: string | null) => void
  onSetCircuitBreaker: (enabled: boolean) => void
  onSetDefaultThinkingLevel: (level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh") => void
  onSetAllowCloud: (enabled: boolean) => void
  onSetCompactionReserveTokens: (n: number) => void
  onSetMaxChainHops: (n: number) => void
}

/** Settings tab for the side panel.
 *  Exposes runtime-tunable room settings that were previously only accessible
 *  via slash commands or env vars. */
export function SettingsPanel({
  roster,
  defaultAgent,
  fallbackAgent,
  circuitBreaker,
  defaultThinkingLevel,
  allowCloud,
  compactionReserveTokens,
  maxChainHops,
  maxRooms,
  turnActive,
  onSetDefaultAgent,
  onSetFallbackAgent,
  onSetCircuitBreaker,
  onSetDefaultThinkingLevel,
  onSetAllowCloud,
  onSetCompactionReserveTokens,
  onSetMaxChainHops,
}: Props) {
  const activeAgents = roster.filter((r) => r.active)

  return (
    <div className="settings-panel">
      <div className="settings-section">
        <h3 className="settings-section-title">Routing</h3>

        <div className="settings-field">
          <span className="settings-label">Default agent</span>
          <select
            className="settings-select"
            value={defaultAgent ?? ""}
            disabled={turnActive}
            onChange={(e) => onSetDefaultAgent(e.target.value || null)}
          >
            <option value="">— auto (first active) —</option>
            {activeAgents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.icon} @{a.id}
              </option>
            ))}
          </select>
          <span className="settings-hint">
            Starting agent for new turns — auto picks the first active agent
          </span>
        </div>

        <div className="settings-field">
          <span className="settings-label">Fallback agent</span>
          <select
            className="settings-select"
            value={fallbackAgent ?? ""}
            disabled={turnActive}
            onChange={(e) => onSetFallbackAgent(e.target.value || null)}
          >
            <option value="">— disabled —</option>
            {activeAgents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.icon} @{a.id}
              </option>
            ))}
          </select>
          <span className="settings-hint">
            Receives routing fallback when no @mention is found in an agent's reply
          </span>
        </div>

        <div className="settings-field">
          <span className="settings-label">Max chain hops</span>
          <input
            className="settings-input"
            type="number"
            min={1}
            max={100}
            value={maxChainHops}
            disabled={turnActive}
            onChange={(e) => {
              const n = Math.max(1, Math.min(100, Number(e.target.value) || 1))
              onSetMaxChainHops(n)
            }}
          />
          <span className="settings-hint">
            Anti-loop: max hops per turn (1–100)
          </span>
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Safety</h3>

        <div className="settings-field">
          <span className="settings-label">Circuit breaker</span>
          <label className="toggle">
            <input
              type="checkbox"
              checked={circuitBreaker}
              disabled={turnActive}
              onChange={(e) => onSetCircuitBreaker(e.target.checked)}
            />
            <span className="toggle-track" />
            <span className="toggle-knob" />
          </label>
          <span className="settings-hint">
            Detects repetition loops and tool-call loops — aborts the turn
          </span>
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Models</h3>

        <div className="settings-field">
          <span className="settings-label">Allow cloud models</span>
          <label className="toggle">
            <input
              type="checkbox"
              checked={allowCloud}
              disabled={turnActive}
              onChange={(e) => onSetAllowCloud(e.target.checked)}
            />
            <span className="toggle-track" />
            <span className="toggle-knob" />
          </label>
          <span className="settings-hint">
            Unlocks cloud providers in the model picker — requires provider API keys
          </span>
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Agents</h3>

        <div className="settings-field">
          <span className="settings-label">Default thinking level</span>
          <select
            className="settings-select"
            value={defaultThinkingLevel}
            disabled={turnActive}
            onChange={(e) => onSetDefaultThinkingLevel(e.target.value as typeof THINKING_LEVELS[number])}
          >
            {THINKING_LEVELS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
          <span className="settings-hint">
            Applied to agents without a per-agent override
          </span>
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Advanced</h3>

        <div className="settings-field">
          <span className="settings-label">Compaction reserve tokens</span>
          <input
            className="settings-input"
            type="number"
            min={5000}
            max={100000}
            step={1000}
            value={compactionReserveTokens}
            disabled={turnActive}
            onChange={(e) => {
              const n = Math.max(5000, Math.min(100000, Number(e.target.value) || 38000))
              onSetCompactionReserveTokens(n)
            }}
          />
          <span className="settings-hint">
            Reserve tokens for auto-compaction — lower = more context before compaction fires. Only affects newly joined agents.
          </span>
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Limits</h3>

        <div className="settings-field">
          <span className="settings-label">Max rooms</span>
          <span className="settings-value">{maxRooms}</span>
          <span className="settings-hint">
            Hard cap — requires PIPELINE_MAX_ROOMS env var to change
          </span>
        </div>
      </div>
    </div>
  )
}
