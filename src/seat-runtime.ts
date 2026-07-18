// SeatRuntime — the stateful owner of ONE pi session per seat (fused seats,
// docs/fused-seats.md; grilling decision: "le Seat possède la session, les
// chapeaux l'empruntent").
//
// Every participant belongs to a seat — a singleton one (seat == persona,
// the pre-feature behavior, byte for byte) or a fused one shared by several
// hats. There is exactly ONE code path: the session-construction logic that
// used to live inside Participant.create moved here, parameterized by the
// seat's hats. A Participant is now a hat handle that borrows this session
// for its turn (Participant.run → acquireTurn).
//
// Structural invariants this class makes impossible to violate:
//  - one seat = one AgentSession = one system prompt = one in-memory state
//    (two hats can never diverge — there is nothing to diverge);
//  - hats of a seat serialize (the turn lock — a session is one conversation);
//  - the seat's toolset is the CONSTANT union of its hats' tools (swapping
//    schemas per turn would re-template the jinja tools block and evict the
//    llama-server prefix cache — the whole win #4); the per-hat restriction
//    is enforced at execution time by hatToolGate, so hat blur degrades into
//    a refused tool call, never into unauthorized action.

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { mkdirSync, rmSync } from "node:fs"
import { access, readFile } from "node:fs/promises"
import { constants } from "node:fs"
import { join } from "node:path"
import { config } from "./config.js"
import { installBatchTerminateGuard, type BatchTerminateGuard } from "./batch-terminate-guard.js"
import { buildConfinedTools } from "./sandbox-tools.js"
import { buildCustomTools } from "./custom-tools/index.js"
import { resolveModelRef, type ResolvedModel } from "./model.js"
import { buildSeatSystemPrompt, hatToolGate, seatCompactionInstructions, type HatSection } from "./seats.js"
import { unionTools } from "./seats.js"
import type { ParentLink, RoomOrchestrator } from "./orchestrator.js"
import type { TaskBoard } from "./task-board.js"
import type { GoalVerdictSink, HandoffSink, Persona } from "./types.js"

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"

/** The workspace-scope note, parameterised by the room's actual root directory.
 *  A room scoped to the pipeline workspace gets the shared-workspace wording;
 *  a room scoped elsewhere (e.g. another project, or the machine root) is told
 *  exactly which directory its file tools are confined to. */
export function workspaceNote(root: string): string {
  return (
    `Your working directory is ${root}. Use paths relative to it ` +
    "(e.g. `notes.md`, `src/app.ts`). Never read or write outside it — absolute paths " +
    "pointing outside this root are denied."
  )
}

/** ask_user guidance — shared verbatim between the team and lone notes so the
 *  two can never drift on the pause semantics. */
const ASK_USER_NOTE =
  "If you need information only the user can provide (preferences, credentials, context), " +
  "use the ask_user tool — it will pause the pipeline and wait for their response. Do NOT " +
  "use it for rhetorical questions or self-clarification."

export const ROOM_NOTE =
  "You are one agent in a shared multi-agent chat room. Other agents (e.g. scout, builder, " +
  "auditor, scribe, tester) are referred to by their lowercase id. To pass your turn to another " +
  "agent, call the handoff tool with their id — that is the ONLY way to hand off. Writing " +
  "'@name' or their name in your reply does NOTHING — there is no text-based routing anymore. " +
  "You can freely discuss, quote, or refer to other agents by name in your reply (e.g. 'the " +
  "builder said...', or narrating what @tester did earlier) without triggering anything — only " +
  "the handoff tool call routes. If you don't call handoff, your turn ends and control returns " +
  "to the human — that is a valid, normal ending, not an error.\n" +
  ASK_USER_NOTE + "\n" +
  "Your personal memory lives at agent_memory/<your_id>.md (e.g. agent_memory/builder.md). " +
  "Read it at the start of a task to recall prior context. The scribe updates these files. " +
  "After a compaction, your memory is refreshed automatically."

/** The lone-agent replacement for ROOM_NOTE: same room mechanics (ask_user
 *  pause, agent_memory), zero team protocol. Injected when the seat is built
 *  with no other active agent — the exact predicate under which the handoff
 *  tool is omitted (custom-tools/index.ts), so the prompt never promises a
 *  mechanism the toolset doesn't carry. */
export const LONE_AGENT_NOTE =
  "You are the only agent in this room, working directly with the human operator. When your " +
  "turn ends, control returns to them — there is no one to hand off to and no team protocol " +
  "to follow.\n" +
  ASK_USER_NOTE + "\n" +
  "Your personal memory lives at agent_memory/<your_id>.md. Read it at the start of a task " +
  "to recall prior context; keep it updated with durable lessons. After a compaction, your " +
  "memory is refreshed automatically."

/** Read a hat's logbook (agent_memory/<id>.md), capped at 4KB to avoid
 *  consuming excessive context tokens. Empty string when absent. */
async function readLogbook(workspaceDir: string, personaId: string): Promise<string> {
  const memoryPath = join(workspaceDir, "agent_memory", `${personaId}.md`)
  try {
    await access(memoryPath, constants.R_OK)
    const raw = await readFile(memoryPath, "utf-8")
    return raw.length > 4096 ? raw.slice(0, 4096) + "… (truncated)" : raw
  } catch {
    return "" // No memory file — fine, first run or not yet populated.
  }
}

/** Everything session construction needs besides the hats themselves — the
 *  same dependencies Participant.create used to take, bundled once so the
 *  Registry can rebuild a seat (hat added/removed/edited) without re-threading
 *  fourteen positional arguments. */
export interface SeatDeps {
  resolved: ResolvedModel
  workspaceDir: string
  orchestrator?: RoomOrchestrator
  defaultThinkingLevel: ThinkingLevel
  allowCloud: boolean
  compactionReserveTokens: number
  /** On-disk session directory for THIS SEAT (…/agents/<convId>/<seatId>).
   *  Undefined → in-memory session (tests, persistence off). */
  sessionDir?: string
  taskBoard?: TaskBoard
  roomId?: string
  parentLink?: ParentLink
  handoffSink?: HandoffSink
  goalVerdictSink?: GoalVerdictSink
}

/** Wrap every tool's execute with the hat gate: a tool owned by another hat
 *  of the seat returns a correctable error naming the owner and the way out
 *  (hand off to switch hats) — the doc §2 degradation contract. */
function gateTools(tools: ToolDefinition[], gate: (toolName: string) => string | null): ToolDefinition[] {
  return tools.map((t) => ({
    ...t,
    execute: (async (...args: unknown[]) => {
      const refusal = gate(t.name)
      if (refusal) {
        return { content: [{ type: "text", text: refusal }], details: undefined }
      }
      return (t.execute as (...a: unknown[]) => Promise<unknown>)(...args)
    }) as ToolDefinition["execute"],
  }))
}

export class SeatRuntime {
  readonly seatId: string
  /** Hats sharing this seat, roster order. Mutated via addHat/removeHat only. */
  hats: Persona[]
  session!: AgentSession
  sessionDir?: string
  /** True when the pi session was reopened from disk with prior conversation
   *  memory (read once at the LAST (re)build — a rebuild over a lived-in dir
   *  is a resume by construction). */
  resumed = false
  /** Index of the next room transcript entry this SEAT has not yet seen.
   *  Seat-level on purpose: the session is one context — replaying an entry
   *  once per hat would inject it twice, the exact duplication tax this
   *  feature exists to kill. Every hat handle reads/writes through this. */
  cursor = 0
  /** The hat wearing (or last to wear) the seat's turn — event routing,
   *  tool attribution and the dynamic allowlist gate all read this. */
  currentHatId: string
  /** Resolved "provider/id" the seat runs (one per seat — invariant validated
   *  by the Registry via validateSeatModels). Null → pi's own resolution. */
  modelRef: string | null = null
  /** True when the LAST build saw no other active agent (lone framing: no
   *  ROOM_NOTE, no roster block — mirroring the handoff-tool omission). The
   *  Registry compares this against the live roster to rebuild on flip. */
  builtLone = false

  private guard: BatchTerminateGuard | null = null
  private unsubscribe: (() => void) | null = null
  /** Per-hat event handlers — the session emits once, the seat forwards to
   *  the hat holding the turn. Registered by each Participant at attach. */
  private handlers = new Map<string, (ev: AgentSessionEvent) => void>()
  /** Intra-seat turn serialization. One session = one conversation = one
   *  turn at a time; hats queue here (parallel flags are meaningless within
   *  a seat — already true de facto on the single llama slot). */
  private turnLock: Promise<void> = Promise.resolve()
  /** Thinking level currently applied to the session — re-applied per turn
   *  only when the acquiring hat wants a different one. */
  private appliedThinkingLevel: ThinkingLevel
  private readonly deps: SeatDeps

  private constructor(seatId: string, hats: Persona[], deps: SeatDeps) {
    this.seatId = seatId
    this.hats = hats
    this.deps = deps
    this.currentHatId = hats[0].id
    this.appliedThinkingLevel = hats[0].thinkingLevel ?? deps.defaultThinkingLevel
    this.sessionDir = deps.sessionDir
  }

  static async create(seatId: string, hats: Persona[], deps: SeatDeps): Promise<SeatRuntime> {
    const seat = new SeatRuntime(seatId, hats, deps)
    await seat.buildSession()
    return seat
  }

  fused(): boolean {
    return this.hats.length > 1
  }

  hatIds(): string[] {
    return this.hats.map((h) => h.id)
  }

  /** The seat's compaction instructions — verbatim for a singleton, labeled
   *  union for a fused seat (grilling decision Q4). */
  compactionInstructions(): string | undefined {
    return seatCompactionInstructions(this.hats)
  }

  /** (Re)build the pi session from the current hats. A rebuild over the same
   *  sessionDir is the established idiom (Registry.update has always done it):
   *  pi reconstructs the system prompt from the resource loader on every open,
   *  so conversation memory survives while prompt/tools refresh. */
  private async buildSession(): Promise<void> {
    const deps = this.deps
    const single = this.hats.length === 1

    // Per-hat logbooks. Singleton: today's memory-note path, byte-compat.
    // Fused: inlined in each hat's section of the seat prompt (grilling Q5 —
    // all of the seat's logbooks, each in its hat's section).
    const logbooks = new Map<string, string>()
    for (const h of this.hats) {
      logbooks.set(h.id, await readLogbook(deps.workspaceDir, h.id))
    }

    // Persona-scoped Agent Skills — union across hats (each name resolves to
    // a skill root; the read tool gets these dirs read-only, see
    // buildConfinedTools).
    const skillRoots = [...new Set(this.hats.flatMap((h) => h.skills ?? []))].map((s) => join(config.skillsDir, s))

    // Lone seat: no other ACTIVE agent exists beside this seat's hats — the
    // same predicate under which buildCustomTools omits the handoff tool (a
    // fused seat is never lone: the hat switch is a legitimate handoff). The
    // prompt and the toolset must agree: a lone seat gets LONE_AGENT_NOTE and
    // no roster block instead of team framing it cannot act on. Snapshot at
    // build time, like the handoff enum; the Registry rebuilds the seat when
    // the predicate flips (reconcileLoneFraming).
    const lone =
      single &&
      deps.handoffSink !== undefined &&
      deps.handoffSink.activeIds().filter((id) => !this.hatIds().includes(id)).length === 0
    this.builtLone = lone

    // Roster awareness: a fused seat reads the block once — every hat is "you".
    const self = single ? this.hats[0].id : this.hatIds()
    const rosterNote = lone ? null : deps.handoffSink?.describeRoster?.(self) ?? null

    // System prompt assembly. Singleton = the exact pre-feature layering;
    // fused = the additive multi-role seat prompt (grilling Q3).
    let promptParts: string[]
    if (single) {
      const memory = logbooks.get(this.hats[0].id) ?? ""
      const memoryNote = memory
        ? `\nYOUR MEMORY (agent_memory/${this.hats[0].id}.md):\n${memory}\n` +
          "---\n(End of memory — updated by the scribe. After compaction, this is refreshed.)\n"
        : ""
      promptParts = [
        ...(this.hats[0].systemPrompt ? [this.hats[0].systemPrompt] : []),
        workspaceNote(deps.workspaceDir),
        lone ? LONE_AGENT_NOTE : ROOM_NOTE,
        ...(rosterNote ? [rosterNote] : []),
        ...(memoryNote ? [memoryNote] : []),
      ]
    } else {
      const sections: HatSection[] = this.hats.map((h) => ({
        persona: h,
        logbook: logbooks.get(h.id) || undefined,
      }))
      promptParts = [
        buildSeatSystemPrompt(this.seatId, sections),
        workspaceNote(deps.workspaceDir),
        ROOM_NOTE,
        ...(rosterNote ? [rosterNote] : []),
      ]
    }

    const loader = new DefaultResourceLoader({
      cwd: deps.workspaceDir,
      agentDir: getAgentDir(),
      ...(skillRoots.length > 0 ? { additionalSkillPaths: skillRoots } : {}),
      // Append to pi's default prompt so we keep tool-usage guidance.
      appendSystemPromptOverride: (base: string[]) => [...base, ...promptParts],
    })
    await loader.reload()

    // One seat = one modelRef (validated upstream; hats[0] is representative).
    const model = resolveModelRef(deps.resolved, deps.allowCloud, this.hats[0].model)
    const effectiveModel = model ?? deps.resolved.model
    this.modelRef = effectiveModel ? `${effectiveModel.provider}/${effectiveModel.id}` : null

    // Auto-compaction: trigger when context exceeds the reserve threshold.
    const settings = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: deps.compactionReserveTokens },
    })

    // Disk-backed session when a sessionDir is given: reopen the most recent
    // session file in it (or start one), so the seat's private context —
    // thinking, tool results, compaction — survives restarts and room resume.
    let sessionManager: SessionManager
    if (this.sessionDir) {
      mkdirSync(this.sessionDir, { recursive: true })
      sessionManager = SessionManager.continueRecent(deps.workspaceDir, this.sessionDir)
      this.resumed = sessionManager.buildSessionContext().messages.length > 0
    } else {
      sessionManager = SessionManager.inMemory(deps.workspaceDir)
    }

    // Toolset: the CONSTANT union of the hats' allowlists (cache-stable), with
    // the per-hat restriction enforced at execution by the dynamic gate.
    const union = unionTools(this.hats)
    const confined = buildConfinedTools(deps.workspaceDir, union, skillRoots)
    const custom = buildCustomTools(union, {
      orchestrator: deps.orchestrator,
      taskBoard: deps.taskBoard,
      personaId: this.hats[0].id,
      roomId: deps.roomId,
      parentLink: deps.parentLink,
      handoffSink: deps.handoffSink,
      goalVerdictSink: deps.goalVerdictSink,
      ...(single
        ? {}
        : {
            hatOf: () => this.currentHatId,
            hatIds: this.hatIds(),
          }),
    })
    let tools = [...confined, ...custom]
    if (!single) {
      tools = gateTools(tools, hatToolGate(this.hats, () => this.currentHatId))
    }

    const { session } = await createAgentSession({
      cwd: deps.workspaceDir,
      // Disable built-in file tools and supply workspace-confined replacements.
      noTools: "builtin",
      customTools: tools,
      thinkingLevel: this.appliedThinkingLevel,
      resourceLoader: loader,
      sessionManager,
      settingsManager: settings,
      authStorage: deps.resolved.authStorage,
      modelRegistry: deps.resolved.modelRegistry,
      ...(model ? { model } : {}),
    })
    session.setAutoCompactionEnabled(true)
    // Name the session after the seat for debug visibility (singleton seats
    // keep the persona id — seatId == persona.id).
    session.setSessionName(this.seatId)
    this.session = session
    // Batch-terminate guard: see batch-terminate-guard.ts.
    this.guard = installBatchTerminateGuard(session.agent)
    this.unsubscribe = session.subscribe((ev) => this.handlers.get(this.currentHatId)?.(ev))
  }

  /** Register/replace the event handler for one hat. The seat fans the single
   *  session subscription out to the hat holding the turn. */
  setHandler(hatId: string, handler: (ev: AgentSessionEvent) => void): void {
    this.handlers.set(hatId, handler)
  }

  removeHandler(hatId: string): void {
    this.handlers.delete(hatId)
  }

  /** Reset the batch-terminate guard at turn start (per-turn state). */
  resetGuard(): void {
    this.guard?.reset()
  }

  /** Serialize hats onto the seat's single conversation. Resolves when the
   *  seat is free; sets the current hat (event routing + tool attribution +
   *  allowlist gate) and applies the hat's thinking level if it differs.
   *  Returns the release function — call in a finally. */
  async acquireTurn(hatId: string, thinkingLevel?: ThinkingLevel): Promise<() => void> {
    const prev = this.turnLock
    let release!: () => void
    this.turnLock = new Promise<void>((res) => (release = res))
    await prev
    this.currentHatId = hatId
    const wanted = thinkingLevel ?? this.deps.defaultThinkingLevel
    if (wanted !== this.appliedThinkingLevel) {
      try {
        await this.session.setThinkingLevel(wanted)
        this.appliedThinkingLevel = wanted
      } catch {
        // Model may not support the level — keep the session's current one.
      }
    }
    return release
  }

  /** Add a hat to a live seat (mid-conversation join — grilling Q2: the
   *  newcomer opens its eyes in the seat's living context). Rebuilds the
   *  session over the same dir: prompt gains the hat's section, toolset
   *  grows to the new union, conversation memory survives. */
  async addHat(persona: Persona): Promise<void> {
    if (this.hats.some((h) => h.id === persona.id)) {
      throw new Error(`hat "${persona.id}" already on seat "${this.seatId}"`)
    }
    this.hats = [...this.hats, persona]
    await this.rebuild()
  }

  /** Remove a hat. Returns true when the seat is now EMPTY (caller disposes
   *  and deletes the session dir — refcounted kick, grilling Q7); a survived
   *  seat rebuilds without the hat's section/tools. */
  async removeHat(hatId: string): Promise<boolean> {
    this.hats = this.hats.filter((h) => h.id !== hatId)
    this.handlers.delete(hatId)
    if (this.hats.length === 0) {
      this.dispose()
      return true
    }
    if (this.currentHatId === hatId) this.currentHatId = this.hats[0].id
    await this.rebuild()
    return false
  }

  /** Replace one hat's persona (Registry.update) and rebuild. */
  async replaceHat(persona: Persona): Promise<void> {
    const idx = this.hats.findIndex((h) => h.id === persona.id)
    if (idx === -1) throw new Error(`hat "${persona.id}" not on seat "${this.seatId}"`)
    this.hats = this.hats.map((h, i) => (i === idx ? persona : h))
    await this.rebuild()
  }

  /** Dispose and rebuild the session from the current hats over the same
   *  sessionDir. The pre-rebuild thinking level is kept (it re-applies per
   *  turn anyway). */
  async rebuild(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.session.dispose()
    await this.buildSession()
  }

  /** Rollback support: the seat's private context contains transcript entries
   *  being removed — dispose, delete the on-disk session, rebuild FRESH.
   *  cursor=0 → the seat replays the kept transcript on its next turn. */
  async wipe(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.session.dispose()
    if (this.sessionDir) rmSync(this.sessionDir, { recursive: true, force: true })
    await this.buildSession()
    this.cursor = 0
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.handlers.clear()
    this.session.dispose()
  }
}
