import { Fragment, useCallback, useState } from "react"
import type { ProviderInfo } from "../types"

interface Props {
  providers: ProviderInfo[]
  _explicitlyEnabled: string[]
  onAdd: (name: string, key: string) => void
  onRemove: (name: string) => void
  onLogin: (name: string) => void
}

export function ProvidersPanel({ providers, onAdd, onRemove, onLogin }: Props) {
  const [adding, setAdding] = useState<string | null>(null)
  const [key, setKey] = useState("")
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [showUnconfigured, setShowUnconfigured] = useState(false)

  const handleAdd = useCallback((name: string) => {
    if (!key.trim()) return
    onAdd(name, key.trim())
    setKey("")
    setAdding(null)
  }, [key, onAdd])

  const handleRemove = useCallback((name: string) => {
    onRemove(name)
    setConfirmRemove(null)
  }, [onRemove])

  const handleLogin = useCallback((name: string) => {
    onLogin(name)
  }, [onLogin])

  const localProvider = providers.find((p) => p.name === "local")
  const configured = providers.filter((p) => p.configured && p.name !== "local")
  const unconfigured = providers.filter((p) => !p.configured && p.name !== "local")

  // Split unconfigured by OAuth support
  const oauthUnconfigured = unconfigured.filter((p) => p.supportsOAuth)
  const apiKeyUnconfigured = unconfigured.filter((p) => !p.supportsOAuth)

  return (
    <div className="providers-panel">
      <h3>Providers</h3>

      {/* Local provider — always present, not configurable */}
      {localProvider && (
        <div className="provider-row local">
          <span className="provider-name">🏠 local</span>
          <span className="provider-status configured" title="llama-server">
            {localProvider.models.length} model{localProvider.models.length !== 1 ? "s" : ""}
          </span>
        </div>
      )}

      {/* Configured cloud providers — inline, compact */}
      {configured.map((p) => (
        <div key={p.name} className="provider-row">
          <div className="provider-info">
            <span className="provider-name">{p.displayName}</span>
            {p.explicitlyEnabled && (
              <span className="provider-badge">explicit</span>
            )}
            <span className="provider-models">
              {p.models.length} model{p.models.length !== 1 ? "s" : ""}
            </span>
          </div>

          <div className="provider-actions">
            <span className="provider-status configured" title={p.source || "configured"}>
              {p.supportsOAuth ? "✓ OAuth" : "✓"}
            </span>
            {p.supportsOAuth && confirmRemove !== p.name && (
              <button
                className="btn-small"
                onClick={() => handleLogin(p.name)}
                title="Re-authenticate via OAuth"
              >
                ↻
              </button>
            )}
            {confirmRemove === p.name ? (
              <div className="confirm-remove">
                <button className="btn-small danger" onClick={() => handleRemove(p.name)}>
                  Confirm
                </button>
                <button className="btn-small" onClick={() => setConfirmRemove(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button
                className="btn-small danger"
                onClick={() => setConfirmRemove(p.name)}
                title="Remove credentials"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      ))}

      {/* Unconfigured providers — collapsible */}
      {unconfigured.length > 0 && (
        <div>
          <button
            className="add-provider-toggle"
            onClick={() => setShowUnconfigured(!showUnconfigured)}
            title={showUnconfigured ? "Collapse" : "Show unconfigured providers"}
          >
            {showUnconfigured ? "▾" : "▸"} Add provider ({unconfigured.length})
          </button>

          {showUnconfigured && (
            <div className="unconfigured-list">
              {/* OAuth providers — show Login button */}
              {oauthUnconfigured.map((p) => (
                <Fragment key={p.name}>
                  <div className="provider-row">
                    <div className="provider-info">
                      <span className="provider-name">{p.displayName}</span>
                      <span className="provider-models">
                        {p.models.length} model{p.models.length !== 1 ? "s" : ""}
                      </span>
                    </div>

                    {adding === p.name ? (
                      <div className="provider-actions">
                        <button className="btn-small primary" onClick={() => handleAdd(p.name)}>
                          Save
                        </button>
                        <button className="btn-small" onClick={() => { setAdding(null); setKey("") }}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="provider-actions">
                        <button
                          className="btn-small primary"
                          onClick={() => handleLogin(p.name)}
                          title="Login via OAuth"
                        >
                          Login
                        </button>
                        <button
                          className="btn-small"
                          onClick={() => { setAdding(p.name); setKey("") }}
                          title="Or paste an API key"
                        >
                          +
                        </button>
                      </div>
                    )}
                  </div>

                  {adding === p.name && (
                    <div className="add-key-row">
                      <input
                        type="text"
                        placeholder="sk-… API key"
                        value={key}
                        onChange={(e) => setKey(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleAdd(p.name)
                          if (e.key === "Escape") { setAdding(null); setKey("") }
                        }}
                        autoFocus
                        className="api-key-input"
                        autoComplete="off"
                        data-1p-ignore
                        data-lpignore="true"
                      />
                    </div>
                  )}
                </Fragment>
              ))}

              {/* API-key-only providers — show key input */}
              {apiKeyUnconfigured.map((p) => (
                <Fragment key={p.name}>
                  <div className="provider-row">
                    <div className="provider-info">
                      <span className="provider-name">{p.displayName}</span>
                      <span className="provider-models">
                        {p.models.length} model{p.models.length !== 1 ? "s" : ""}
                      </span>
                    </div>

                    {adding === p.name ? (
                      <div className="provider-actions">
                        <button className="btn-small primary" onClick={() => handleAdd(p.name)}>
                          Save
                        </button>
                        <button className="btn-small" onClick={() => { setAdding(null); setKey("") }}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        className="btn-small"
                        onClick={() => { setAdding(p.name); setKey("") }}
                        title="Add API key"
                      >
                        +
                      </button>
                    )}
                  </div>

                  {adding === p.name && (
                    <div className="add-key-row">
                      <input
                        type="text"
                        placeholder="sk-… API key"
                        value={key}
                        onChange={(e) => setKey(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleAdd(p.name)
                          if (e.key === "Escape") { setAdding(null); setKey("") }
                        }}
                        autoFocus
                        className="api-key-input"
                        autoComplete="off"
                        data-1p-ignore
                        data-lpignore="true"
                      />
                    </div>
                  )}
                </Fragment>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
