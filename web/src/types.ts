export interface RosterItem {
  id: string
  name: string
  color: string
  icon: string
  tools: string[]
  active: boolean
  status: "idle" | "active" | "thinking" | "working"
  /** Per-agent model "provider/id", or undefined when on the default. */
  model?: string
  /** May run concurrently with adjacent parallel-flagged agents. */
  parallel: boolean
}

/** A model offered for per-agent selection (GET /api/models). */
export interface ModelInfo {
  provider: string
  id: string
  ref: string
  name: string
  local: boolean
}

export interface ToolActivity {
  toolCallId: string
  toolName: string
  args?: unknown
  status: "running" | "ok" | "error"
  result?: string
  ts: number
}

export interface Message {
  index: number
  author: string // "user" or participant id
  authorName: string
  text: string
  ts: number
  activity?: ToolActivity[]
}

/** Full persona, as returned by GET /api/participants/:id (for the edit form). */
export interface PersonaDetail {
  id: string
  name: string
  color: string
  icon: string
  tools: string[]
  systemPrompt: string
  model?: string
}

export interface Receipt {
  participantId: string
  created: string[]
  modified: string[]
  deleted: string[]
}

export interface WorkspaceFile {
  path: string
  size: number
}

export interface Notice {
  id: number
  msg: string
  level: "info" | "error"
}

export interface ConversationMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}
