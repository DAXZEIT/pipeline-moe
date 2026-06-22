import { useState } from "react"
import type { WorkspaceFile } from "../types"
import { PresetsPanel } from "./PresetsPanel"

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

type Tab = "workspace" | "presets"

/** Right-hand side panel with two tabs: the live workspace file listing and a
 *  detailed presets browser. Replaces the former workspace-only panel. */
export function SidePanel({
  files,
  turnActive,
  onLoadPreset,
  onApplyPreset,
}: {
  files: WorkspaceFile[]
  turnActive: boolean
  onLoadPreset: (name: string) => Promise<{ downgraded?: Array<{ agent: string; model: string }> }>
  onApplyPreset: (name: string) => Promise<{ downgraded?: Array<{ agent: string; model: string }> }>
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
        </div>
        <div className="workspace-sub">
          {tab === "workspace" ? `${files.length} files · live` : "saved rosters"}
        </div>
      </div>

      {tab === "workspace" ? (
        <div className="workspace-list">
          {files.length === 0 && <div className="workspace-empty">empty</div>}
          {files.map((f) => (
            <div key={f.path} className="workspace-file">
              <span className="wf-path" title={f.path}>{f.path}</span>
              <span className="wf-size">{formatSize(f.size)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="workspace-list">
          <PresetsPanel turnActive={turnActive} onLoad={onLoadPreset} onApply={onApplyPreset} />
        </div>
      )}
    </aside>
  )
}
