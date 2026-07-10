// Shared types for the Pipeline-MoE backend.

/** A persona/agent definition. `tools` is a pi built-in tool allowlist. */
export interface Persona {
  /** Stable slug, also used as @mention handle (lowercase). */
  id: string
  /** Display name. */
  name: string
  /** Hex color for the UI avatar. */
  color: string
  /** Emoji/icon for the UI avatar. */
  icon: string
  /** pi built-in tool allowlist: read, bash, edit, write, grep, find, ls. */
  tools: string[]
  /** Persona instructions appended to pi's default system prompt. */
  systemPrompt: string
  /** Optional per-agent model as "provider/id". Undefined → the process default
   *  (PIPELINE_MODEL / first local). Lets each role run on its own architecture. */
  model?: string
  /** Per-agent thinking/effort level. Undefined → inherit from global PIPELINE_THINKING. */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  /** Custom instructions for context compaction — tells the summarizer what to preserve vs discard for this role. */
  compactionInstructions?: string
  /** Whether this agent receives image attachments. Undefined → true (assumed
   *  capable). Set false for a local model with no mmproj loaded — llama.cpp
   *  refuses the request outright if an image reaches a vision-less model. */
  vision?: boolean
  /** Agent Skills (agentskills.io) granted to this persona, by directory name
   *  under the process skills dir (config.skillsDir, default <cwd>/skills).
   *  Each name resolves to a SKILL.md skill root; pi injects its name +
   *  description into the system prompt and the agent reads the body on
   *  demand — procedural playbooks stay out of the always-on prompt. */
  skills?: string[]
}

export type ParticipantStatus = "idle" | "active" | "thinking" | "working" | "compacting" | "retrying"

/** One tool call an agent made during a turn — what it did, not just the result. */
export interface ToolActivity {
  /** Stable id from pi, used to match the start event with its end. */
  toolCallId: string
  /** e.g. "bash", "read", "write", "edit". */
  toolName: string
  /** The arguments the agent passed (command, path, …). */
  args?: unknown
  status: "running" | "ok" | "error"
  /** Truncated string form of the tool result, set on completion. */
  result?: string
  ts: number
}

/** A transcript line in the shared room. */
export interface TranscriptEntry {
  /** Monotonic index into the room transcript. */
  index: number
  /** Author: "user" or a participant id. */
  author: string
  /** Display name of the author. */
  authorName: string
  text: string
  ts: number
  /** Tool calls made while producing this message (agent messages only). */
  activity?: ToolActivity[]
  /** Reasoning trace, if any (agent messages only). */
  reasoning?: string
  /** Paths to saved images (relative to workspace), e.g. "media/abc123.png". */
  images?: string[]
  /** If this message is a question posed to the user via ask_user, the question text. */
  question?: string
  /** Closed answer choices offered with the question — display metadata only,
   *  the answer always travels back as an ordinary text message. */
  questionOptions?: string[]
  /** Wall-clock milliseconds the agent was active producing this message
   *  (model streaming + tool execution; excludes waiting on the local-model
   *  lock). pi's SessionStats has no timing — the room measures the turn. */
  durationMs?: number
}

/** A file-change receipt produced by diffing the workspace around an agent turn. */
export interface WorkReceipt {
  participantId: string
  created: string[]
  modified: string[]
  deleted: string[]
}

/** A persona plus its runtime flags, as persisted inside a conversation. */
export interface PersonaState extends Persona {
  active: boolean
  /** May run concurrently with adjacent parallel-flagged agents (lane-capped:
   *  local agents still serialize on the single llama slot). Optional for
   *  back-compat with conversations saved before this existed. */
  parallel?: boolean
  /** Index of the next transcript entry the agent had NOT yet seen when this
   *  conversation was saved. Only honored when the agent's on-disk pi session
   *  is restored alongside it — a fresh session always starts at 0 so it
   *  catches up on the whole transcript. */
  cursor?: number
}

/** A saved group conversation: its roster, transcript, and settings. */
/** How agent→agent handoffs are routed within a room.
 *  - `auto`   — handoffs chain directly (default).
 *  - `semi`   — each proposed handoff pauses for human approval before dispatch.
 *  - `manual` — no agent→agent chaining; the human routes every step. */
export type RoutingMode = "auto" | "semi" | "manual"

/** Capability surface for the `handoff` tool: lets an agent pass its turn to
 *  another active agent via a single tool call instead of a free-text
 *  @mention. Prose @mentions in an agent reply cannot be told apart from a
 *  quote or description of someone else's handoff (F5) — the tool replaces
 *  that ambiguity with a menu pick. The Registry implements this (it already
 *  owns the live roster); the tool calls `activeIds()` to build/validate its
 *  enum and `register()` to record the chosen target. Room consumes the
 *  registration once per turn — see Room.resolveHandoff. Human `@name` 
 *  routing (resolveTargets) is untouched; this only replaces the agent-reply
 *  path (former resolveAgentMentions). */
export interface HandoffSink {
  /** Ids of currently active participants — the tool's enum is built from
   *  this at construction, and execution re-checks it live so a roster
   *  change mid-session is rejected with a correctable error instead of
   *  silently misrouting. */
  activeIds(): string[]
  /** Record `from`'s chosen handoff target for the current turn. Overwrites
   *  any earlier registration for the same agent within the turn. */
  register(from: string, to: string): void
}

/** A human decision on a proposed handoff (semi/manual routing). */
export interface RouteDecision {
  action: "approve" | "redirect" | "drop"
  /** For 'redirect': the agent id(s) to route to instead of the proposal. */
  targetIds?: string[]
}

// ── Task board ──────────────────────────────────────────────────────────────

export type TaskStatus = "pending" | "in_progress" | "completed"

/** One entry on the room's shared task board — the live decomposition of the
 *  current work, maintained by the agents themselves via the task_* tools
 *  (typically the planner creates, owners update). Room-scoped and persisted
 *  with the conversation, unlike plans (.pi/plans) which are global and act
 *  as the engineering contract. */
export interface RoomTask {
  id: number
  subject: string
  status: TaskStatus
  /** Agent id responsible for the task. Optional — unowned tasks are fine. */
  owner?: string
  /** Agent id (or "user") that created the task. */
  createdBy: string
  ts: number
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** Whether agent→agent chaining was on for this discussion. Derived from
   *  `routingMode` (auto/semi → true, manual → false); kept for back-compat. */
  chaining: boolean
  /** Routing mode for this discussion. Absent in older saved conversations —
   *  derived from `chaining` on load. */
  routingMode?: RoutingMode
  /** Agent that receives messages with no @mention. null = first active. */
  defaultAgent: string | null
  /** Agent that receives routing fallback when no @mention is found in an agent's reply. null = disabled. */
  fallbackAgent?: string | null
  /** Whether the active plan's next incomplete step owner (`[agent]` prefix)
   *  is consulted before the generic fallback agent. Defaults to true when absent. */
  planAwareRouting?: boolean
  /** Default thinking level for agents without a per-agent override.
   *  Defaults to config.thinkingLevel when absent. */
  defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  /** Whether cloud models are allowed in this discussion.
   *  Defaults to config.allowCloud when absent. */
  allowCloud?: boolean
  /** Reserve tokens for auto-compaction. Defaults to 38000 when absent. */
  compactionReserveTokens?: number
  /** The roster (personas + active flags) this discussion ran with. */
  personas: PersonaState[]
  transcript: TranscriptEntry[]
  /** Shared task board. Absent in older saved conversations — treated as empty. */
  tasks?: RoomTask[]
}

/** Lightweight conversation descriptor for the UI picker. */
export interface ConversationMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}
