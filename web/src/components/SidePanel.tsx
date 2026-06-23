import { useState } from "react"
import type { WorkspaceFile, RosterItem } from "../types"
import { PresetsPanel } from "./PresetsPanel"
import { SettingsPanel } from "./SettingsPanel"

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

type Tab = "workspace" | "presets" | "settings"

/** Right-hand side panel with three tabs: live workspace file listing,
 *  presets browser, and runtime settings. */
export function SidePanel({
  files,
  turnActive,
  onLoadPreset,
  onApplyPreset,
  // Settings props
  roster,
  defaultAgent,
  fallbackAgent,
  circuitBreaker,
  defaultThinkingLevel,
  allowCloud,
  compactionReserveTokens,
  maxChainHops,
  maxRooms,
  onSetDefaultAgent,
  onSetFallbackAgent,
  onSetCircuitBreaker,
  onSetDefaultThinkingLevel,
  onSetAllowCloud,
  onSetCompactionReserveTokens,
  onSetMaxChainHops,
}: {
  files: WorkspaceFile[]
  turnActive: boolean
  onLoadPreset: (name: string) => Promise<{ downgraded?: Array<{ agent: string; model: string }> }>
  onApplyPreset: (name: string) => Promise<{ downgraded?: Array<{ agent: string; model: string }> }>
  // Settings
  roster: RosterItem[]
  defaultAgent: string | null
  fallbackAgent: string | null
  circuitBreaker: boolean
  defaultThinkingLevel: string
  allowCloud: boolean
  compactionReserveTokens: number
  maxChainHops: number
  maxRooms: number
  onSetDefaultAgent: (id: string | null) => void
  onSetFallbackAgent: (id: string | null) => void
  onSetCircuitBreaker: (enabled: boolean) => void
  onSetDefaultThinkingLevel: (level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh") => void
  onSetAllowCloud: (enabled: boolean) => void
  onSetCompactionReserveTokens: (n: number) => void
  onSetMaxChainHops: (n: number) => void
}) {
  const [tab, setTab] = useState<Tab>("workspace")

  return (
    <aside className="workspace">
      <div className="workspace-head">
        <div className="side-tabs">
          <button
            className={`side-tab${tab === "workspace" ? " active" : ""}`}
            onClick={() => setTab("workspace")}
          >
            Workspace
          </button>
          <button
            className={`side-tab${tab === "presets" ? " active" : ""}`}
            onClick={() => setTab("presets")}
          >
            Presets
          </button>
          <button
            className={`side-tab${tab === "settings" ? " active" : ""}`}
            onClick={() => setTab("settings")}
          >
            Settings
          </button>
        </div>
        <div className="workspace-sub">
          {tab === "workspace" && `${files.length} files · live`}
          {tab === "presets" && "saved rosters"}
          {tab === "settings" && "room config"}
        </div>
      </div>

      {tab === "workspace" && (
        <div className="workspace-list">
          {files.length === 0 && <div className="workspace-empty">empty</div>}
          {files.map((f) => (
            <div key={f.path} className="workspace-file">
              <span className="wf-path" title={f.path}>{f.path}</span>
              <span className="wf-size">{formatSize(f.size)}</span>
            </div>
          ))}
        </div>
      )}

      {tab === "presets" && (
        <div className="workspace-list">
          <PresetsPanel turnActive={turnActive} onLoad={onLoadPreset} onApply={onApplyPreset} />
        </div>
      )}

      {tab === "settings" && (
        <SettingsPanel
          roster={roster}
          defaultAgent={defaultAgent}
          fallbackAgent={fallbackAgent}
          circuitBreaker={circuitBreaker}
          defaultThinkingLevel={defaultThinkingLevel}
          allowCloud={allowCloud}
          compactionReserveTokens={compactionReserveTokens}
          maxChainHops={maxChainHops}
          maxRooms={maxRooms}
          turnActive={turnActive}
          onSetDefaultAgent={onSetDefaultAgent}
          onSetFallbackAgent={onSetFallbackAgent}
          onSetCircuitBreaker={onSetCircuitBreaker}
          onSetDefaultThinkingLevel={onSetDefaultThinkingLevel}
          onSetAllowCloud={onSetAllowCloud}
          onSetCompactionReserveTokens={onSetCompactionReserveTokens}
          onSetMaxChainHops={onSetMaxChainHops}
        />
      )}
    </aside>
  )
}
