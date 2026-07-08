export interface RosterItem {
  id: string
  name: string
  color: string
  icon: string
  tools: string[]
  active: boolean
  status: "idle" | "active" | "thinking" | "working" | "compacting" | "retrying"
  /** Retry metadata, present when status is "retrying". */
  retry?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  /** Per-agent model "provider/id", or undefined when on the default. */
  model?: string
  /** Per-agent thinking level, or undefined when inheriting from global config. */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  /** Whether this agent receives image attachments. Undefined → true (assumed capable). */
  vision?: boolean
  /** May run concurrently with adjacent parallel-flagged agents. */
  parallel: boolean
  /** Context token usage — populated after each turn via SSE status event. */
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null }
  /** Session stats — populated after each turn via SSE status event. */
  sessionStats?: {
    userMessages: number
    assistantMessages: number
    toolCalls: number
    totalMessages: number
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
    cost: number
  }
}

/** One entry on the room's shared task board — created/updated by the agents
 *  via their task_* tools, displayed live in the TUI/web clients. */
export interface RoomTask {
  id: number
  subject: string
  status: "pending" | "in_progress" | "completed"
  /** Agent id responsible for the task, if assigned. */
  owner?: string
  /** Agent id (or "user") that created it. */
  createdBy: string
  ts: number
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
  /** Reasoning trace (agent messages only, persisted after turn completion). */
  reasoning?: string
  /** Image paths (workspace-relative, e.g. "media/abc.png"). */
  images?: string[]
  /** If this message is a question posed to the user via ask_user. */
  question?: string
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
  /** Per-agent thinking level, or undefined when inheriting from global config. */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  /** Thinking levels supported by the current model (from pi session). */
  availableThinkingLevels?: string[]
  /** Custom instructions for context compaction. */
  compactionInstructions?: string
  /** Whether this agent receives image attachments. Undefined → true (assumed capable). */
  vision?: boolean
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

/** A saved room preset. */
export interface PresetPersona {
  id: string
  name: string
  color: string
  icon: string
  tools: string[]
  systemPrompt?: string
  model?: string
  thinkingLevel?: string
  active: boolean
  parallel?: boolean
}

export interface PresetFile {
  name: string
  personas: PresetPersona[]
}

/** How agent→agent handoffs are routed within a room. */
export type RoutingMode = "auto" | "semi" | "manual"

/** A proposed handoff awaiting human approval (semi/manual routing). */
export interface RouteProposal {
  from: string
  target: string
  targetName: string
}

/** A human decision on a proposed handoff. */
export interface RouteDecision {
  action: "approve" | "redirect" | "drop"
  targetIds?: string[]
}

/** Room settings payload (GET/PATCH /settings). */
export interface RoomSettings {
  chaining: boolean
  routingMode: RoutingMode
  defaultAgent: string | null
  fallbackAgent?: string | null
  maxChainHops: number
  defaultThinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  allowCloud: boolean
  compactionReserveTokens: number
  maxRooms: number
  pendingRoute: { proposals: RouteProposal[] } | null
}

/** A built-in persona template (GET /api/persona-templates) for the Add-agent picker. */
export interface PersonaTemplate {
  id: string
  name: string
  color: string
  icon: string
  tools: string[]
  model?: string
}

/** A room listed by GET /api/rooms. */
export interface RoomSummary {
  roomId: string
  name: string
  participantCount: number
  goalStatus: string
  goalText: string | null
  /** The room's workspace directory on the server host. Clients on the same
   *  host can run `!` shell commands directly inside it. Optional for
   *  back-compat with older servers. */
  workspaceDir?: string
}

/** A closed room with on-disk data, listed by GET /api/rooms/resumable. */
export interface ResumableRoom {
  roomId: string
  name: string
  workspaceDir?: string
  lastActivity: number
  messageCount: number
  hasMeta: boolean
}

/** Live state of an in-flight OAuth device/auth flow (from oauth_progress SSE). */
export interface OAuthProgress {
  provider: string
  status: "device_code" | "auth_url" | "prompt" | "progress" | "success" | "error"
  verificationUri?: string
  userCode?: string
  url?: string
  instructions?: string
  message?: string
  /** Input hint when the flow asks for a pasted code/redirect URL (status "prompt"). */
  placeholder?: string
}

/** A provider listed by GET /api/providers. */
export interface ProviderInfo {
  name: string
  displayName: string
  configured: boolean
  source?: string
  label?: string
  explicitlyEnabled: boolean
  /** Whether this provider supports OAuth login (e.g. Anthropic, GitHub). */
  supportsOAuth?: boolean
  models: Array<{ id: string; name: string }>
}
