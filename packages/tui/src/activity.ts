import type { ToolActivity } from "@pipeline-moe/client-core"

/** One-line summary of a tool's args: the command, path, or pattern it acted on. */
export function summarizeArgs(a: ToolActivity): string {
  const args = a.args as Record<string, unknown> | undefined
  if (!args || typeof args !== "object") return ""
  for (const key of ["command", "file_path", "path", "pattern"]) {
    const v = args[key]
    if (typeof v === "string") return v
  }
  try {
    return JSON.stringify(args)
  } catch {
    return ""
  }
}

export const TOOL_ICON: Record<string, string> = {
  bash: "⌘",
  read: "📖",
  write: "✎",
  edit: "✏️",
  grep: "🔍",
  find: "📁",
  ls: "📂",
}

/** Status badge text and color. */
export function statusBadge(status: string): { text: string; color: string } {
  switch (status) {
    case "ok": return { text: "ok", color: "green" }
    case "error": return { text: "err", color: "red" }
    default: return { text: "…", color: "yellow" }
  }
}
