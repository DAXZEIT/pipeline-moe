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
}

export type ParticipantStatus = "idle" | "active" | "thinking" | "working"

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
}

/** A saved group conversation: its roster, transcript, and settings. */
export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** Whether agent→agent chaining was on for this discussion. */
  chaining: boolean
  /** Agent that receives messages with no @mention. null = first active. */
  defaultAgent: string | null
  /** The roster (personas + active flags) this discussion ran with. */
  personas: PersonaState[]
  transcript: TranscriptEntry[]
}

/** Lightweight conversation descriptor for the UI picker. */
export interface ConversationMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}
