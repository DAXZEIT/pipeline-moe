import type { WorkspaceFile } from "../types"

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

export function WorkspacePanel({ files }: { files: WorkspaceFile[] }) {
  return (
    <aside className="workspace">
      <div className="workspace-head">
        <div className="workspace-title">WORKSPACE</div>
        <div className="workspace-sub">{files.length} files · live</div>
      </div>
      <div className="workspace-list">
        {files.length === 0 && <div className="workspace-empty">empty</div>}
        {files.map((f) => (
          <div key={f.path} className="workspace-file">
            <span className="wf-path" title={f.path}>
              {f.path}
            </span>
            <span className="wf-size">{formatSize(f.size)}</span>
          </div>
        ))}
      </div>
    </aside>
  )
}
