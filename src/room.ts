// The Room: shared transcript + serial turn queue + @mention routing + work
// receipts. One room per process. All model work is serialised here, which
// also matches llama-server running with --parallel 1.

import { config } from "./config.js"
import { diffSnapshots, listWorkspace, receiptHasChanges, snapshot } from "./receipts.js"
import type { Registry } from "./registry.js"
import type { Participant } from "./participant.js"
import type { ConversationStore } from "./store.js"
import { conversationMeta } from "./store.js"
import type { SseHub } from "./sse.js"
import type {
  Conversation,
  ConversationMeta,
  Persona,
  ToolActivity,
  TranscriptEntry,
  WorkReceipt,
} from "./types.js"

/** State when the pipeline is paused waiting for a user response to an ask_user. */
interface PendingQuestion {
  askerId: string
  heldQueue: Participant[]
}

const MENTION_RE = /@(\w+)/g

/** What one agent produced in a turn, before it is posted to the transcript. */
interface RunOutput {
  target: Participant
  reply: string
  activity: ToolActivity[]
  reasoning?: string
  receipt: WorkReceipt
  /** If the agent called ask_user, the question text. */
  question?: string
}

function newConvId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export class Room {
  private transcript: TranscriptEntry[] = []
  private chain: Promise<void> = Promise.resolve()
  /** Agents currently mid-turn. >1 when a parallel wave is running. */
  private running = new Set<Participant>()
  /** Id of the first agent that started the current turn. Used for UI targeting (steer). */
  private runningAgentId: string | null = null
  /** Pending agents to run in the current routing pass. Mutated as agents chain. */
  private queue: Participant[] = []
  private aborted = false
  /** When true, agents' @mentions chain to other agents. No turn budget. */
  private chaining = true
  /** Set when an agent called ask_user — pipeline is paused until user responds. */
  private pendingQuestion: PendingQuestion | null = null
  /** Agent that handles messages with no @mention. null = first active. */
  private defaultAgentId: string | null = null

  // ── Current conversation identity ──────────────────────────────────────────
  private convId = newConvId()
  private convTitle = "Discussion 1"
  private convCreatedAt = Date.now()
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly registry: Registry,
    private readonly hub: SseHub,
    private readonly store: ConversationStore,
    private readonly seedPersonas: Persona[],
  ) {}

  getTranscript(): TranscriptEntry[] {
    return this.transcript
  }

  getChaining(): boolean {
    return this.chaining
  }

  setChaining(value: boolean): void {
    this.chaining = value
    this.broadcastSettings()
    void this.saveCurrent()
  }

  getDefaultAgent(): string | null {
    return this.defaultAgentId
  }

  /** Set the agent that handles un-mentioned messages. null = first active. */
  setDefaultAgent(id: string | null): void {
    if (id !== null && !this.registry.has(id)) throw new Error(`unknown participant "${id}"`)
    this.defaultAgentId = id
    this.broadcastSettings()
    void this.saveCurrent()
  }

  private broadcastSettings(): void {
    this.hub.broadcast("settings", { chaining: this.chaining, defaultAgent: this.defaultAgentId })
  }

  // ── Conversation lifecycle ──────────────────────────────────────────────────

  /** Load the most recent saved conversation, or seed a fresh one. Wires autosave. */
  async init(): Promise<void> {
    await this.store.init()
    const metas = await this.store.list()
    const latest = metas[0] ? await this.store.read(metas[0].id) : null
    if (latest) {
      await this.applyConversation(latest)
    } else {
      await this.startFresh(
        "Discussion 1",
        this.seedPersonas.map((p) => ({ ...p, active: true })),
      )
    }
    // From now on, any roster change autosaves the current conversation.
    this.registry.onChange = () => this.scheduleSave()
  }

  private buildConversation(): Conversation {
    return {
      id: this.convId,
      title: this.convTitle,
      createdAt: this.convCreatedAt,
      updatedAt: Date.now(),
      chaining: this.chaining,
      defaultAgent: this.defaultAgentId,
      personas: this.registry.personaStates(),
      transcript: this.transcript,
    }
  }

  /** Persist the current conversation and push the refreshed list to clients. */
  async saveCurrent(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.store.write(this.buildConversation())
    await this.broadcastConversations()
  }

  /** Debounced autosave, for bursty roster mutations. */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.saveCurrent()
    }, 400)
  }

  async getConversations(): Promise<{ currentId: string; list: ConversationMeta[] }> {
    return { currentId: this.convId, list: await this.store.list() }
  }

  private async broadcastConversations(): Promise<void> {
    this.hub.broadcast("conversations", {
      currentId: this.convId,
      list: await this.store.list(),
    })
  }

  /** True while an agent is running or queued — editing a roster member's
   *  session (which disposes+recreates it) is unsafe during this window. */
  isBusy(): boolean {
    return this.running.size > 0 || this.queue.length > 0 || this.pendingQuestion !== null
  }

  private ensureIdle(): void {
    if (this.running.size > 0 || this.queue.length > 0 || this.pendingQuestion !== null) {
      throw new Error("a turn is running — press Stop before switching discussions")
    }
  }

  /** Become a brand-new empty conversation with the given roster. */
  private async startFresh(title: string, personas: Conversation["personas"]): Promise<void> {
    this.convId = newConvId()
    this.convTitle = title
    this.convCreatedAt = Date.now()
    this.transcript = []
    this.defaultAgentId = null // fresh discussion → first active is the default
    await this.registry.reset(personas)
    this.hub.broadcast("transcript", this.transcript)
    this.broadcastSettings()
    await this.saveCurrent()
  }

  /** Make a saved conversation the live one (fresh sessions, replayed transcript). */
  private async applyConversation(conv: Conversation): Promise<void> {
    this.convId = conv.id
    this.convTitle = conv.title
    this.convCreatedAt = conv.createdAt
    this.chaining = conv.chaining
    this.defaultAgentId = conv.defaultAgent ?? null

    // Guard against a corrupt save with an empty roster (e.g. a botched
    // out-of-band edit / mid-turn restart). An empty roster would brick the UI
    // permanently — and since init() loads the most recent conversation, it
    // would do so on every boot. Fall back to the seed personas and re-persist.
    let healed = false
    let personas = conv.personas
    if (personas.length === 0) {
      personas = this.seedPersonas.map((p) => ({ ...p, active: true }))
      healed = true
    }
    await this.registry.reset(personas)
    // cursor=0 (set by reset→create) means each agent catches up on the whole
    // transcript on its next turn — its fresh session has no prior memory.
    this.transcript = conv.transcript.map((e) => ({ ...e }))
    this.broadcastSettings()
    this.hub.broadcast("transcript", this.transcript)
    if (healed) {
      this.notice(`"${conv.title}" had an empty roster — restored the seed agents.`, "info")
      await this.saveCurrent() // make the repair stick on disk
    }
    await this.broadcastConversations()
  }

  /** Start a new discussion, inheriting the current roster. Returns its metadata. */
  async newConversation(title?: string): Promise<ConversationMeta> {
    this.ensureIdle()
    await this.saveCurrent()
    const personas = this.registry.personaStates()
    const count = (await this.store.list()).length
    await this.startFresh(title?.trim() || `Discussion ${count + 1}`, personas)
    return conversationMeta(this.buildConversation())
  }

  /** Switch to a saved discussion. No-op if already current. */
  async switchConversation(id: string): Promise<void> {
    this.ensureIdle()
    if (id === this.convId) return
    const conv = await this.store.read(id)
    if (!conv) throw new Error(`unknown conversation "${id}"`)
    await this.saveCurrent() // flush the one we're leaving
    await this.applyConversation(conv)
  }

  async renameConversation(id: string, title: string): Promise<void> {
    const clean = title.trim()
    if (!clean) throw new Error("title is required")
    if (id === this.convId) {
      this.convTitle = clean
      await this.saveCurrent()
      return
    }
    const conv = await this.store.read(id)
    if (!conv) throw new Error(`unknown conversation "${id}"`)
    conv.title = clean
    conv.updatedAt = Date.now()
    await this.store.write(conv)
    await this.broadcastConversations()
  }

  async deleteConversation(id: string): Promise<void> {
    this.ensureIdle()
    await this.store.remove(id)
    if (id === this.convId) {
      // Deleted the live one: fall back to the most recent remaining, else seed.
      const metas = await this.store.list()
      const next = metas[0] ? await this.store.read(metas[0].id) : null
      if (next) await this.applyConversation(next)
      else
        await this.startFresh(
          "Discussion 1",
          this.seedPersonas.map((p) => ({ ...p, active: true })),
        )
    } else {
      await this.broadcastConversations()
    }
  }

  private post(
    author: string,
    authorName: string,
    text: string,
    activity?: ToolActivity[],
    reasoning?: string,
    images?: string[],
    question?: string,
  ): TranscriptEntry {
    const entry: TranscriptEntry = {
      index: this.transcript.length,
      author,
      authorName,
      text,
      ts: Date.now(),
      ...(activity && activity.length > 0 ? { activity } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(images && images.length > 0 ? { images } : {}),
      ...(question ? { question } : {}),
    }
    this.transcript.push(entry)
    this.hub.broadcast("message", entry)
    return entry
  }

  private notice(msg: string, level: "info" | "error" = "info"): void {
    this.hub.broadcast("notice", { msg, level })
  }

  /** End the current turn — clears runningAgentId and broadcasts turn end. */
  private async endTurn(): Promise<void> {
    this.runningAgentId = null
    this.hub.broadcast("turn", { phase: "end" })
    this.hub.broadcast("workspace", await listWorkspace(config.workspaceDir))
  }

  /** Steer a running agent mid-turn. Posts a (steered) notice to the transcript
   *  for visibility, then queues the message via the agent's session. */
  async steer(targetId: string, text: string): Promise<void> {
    const p = this.registry.get(targetId)
    if (!p) throw new Error(`unknown participant "${targetId}"`)
    // Post a visible record to the transcript.
    this.post("user", "You", `↳ steered @${targetId}: ${text}`)
    await p.steer(text)
  }

  /** Parse @mentions and resolve to the ordered list of participants to run. */
  private resolveTargets(text: string): Participant[] {
    const mentioned = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = MENTION_RE.exec(text)) !== null) mentioned.add(m[1].toLowerCase())

    // @all (human-only) fans out to everyone, even alongside other mentions.
    if (mentioned.has("all")) {
      return this.registry.activeParticipants()
    }

    // No mention → the default agent (or the first active one as fallback).
    if (mentioned.size === 0) {
      const active = this.registry.activeParticipants()
      if (active.length === 0) return []
      const preferred = this.defaultAgentId
        ? active.find((p) => p.persona.id === this.defaultAgentId)
        : undefined
      return [preferred ?? active[0]]
    }

    const targets: Participant[] = []
    for (const id of mentioned) {
      const p = this.registry.get(id)
      if (!p) {
        this.notice(`No participant "@${id}" in the room.`, "error")
        continue
      }
      if (!p.active) {
        this.notice(`@${id} is deactivated — skipping.`, "info")
        continue
      }
      targets.push(p)
    }
    return targets
  }

  /** Resolve @mentions emitted BY an agent. No @all (human-only), never the
   *  speaker itself, active participants only. No budget / anti-rebound for now. */
  private resolveAgentMentions(text: string, selfId: string): Participant[] {
    const mentioned = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = MENTION_RE.exec(text)) !== null) mentioned.add(m[1].toLowerCase())
    mentioned.delete("all") // agents cannot fan out to everyone
    mentioned.delete(selfId) // no self-invocation

    const out: Participant[] = []
    for (const id of mentioned) {
      const p = this.registry.get(id)
      if (p && p.active) out.push(p)
    }
    return out
  }

  /** Build the prompt for a participant: the room lines it hasn't seen yet
   *  (excluding its own past messages, which live in its session memory).
   *  Also collects images from the last user message for vision support. */
  private buildContext(p: Participant): { text: string; images?: string[] } {
    const unseen = this.transcript
      .slice(p.cursor)
      .filter((e) => e.author !== p.persona.id)
    const lines = unseen.map((e) => `${e.authorName}: ${e.text}`).join("\n\n")

    // Collect images from the last user message in the unseen range.
    // These are the images the user attached to their most recent message.
    const userEntry = [...unseen].reverse().find((e) => e.author === "user")
    const images = userEntry?.images

    return {
      text: `${lines}\n\n---\nYou are ${p.persona.name}. Respond to the conversation above from your perspective now.`,
      images,
    }
  }

  /** Public entry point. Enqueues the message; processing streams over SSE. */
  submit(text: string, images?: string[]): void {
    this.chain = this.chain.then(() => this.process(text, images)).catch((err) => {
      this.notice(`Room error: ${err instanceof Error ? err.message : String(err)}`, "error")
    })
  }

  private async process(text: string, images?: string[]): Promise<void> {
    const trimmed = text.trim()

    // Handle /cancel while paused — cancel the question and drain the held queue.
    if (this.pendingQuestion && trimmed === "/cancel") {
      const held = this.pendingQuestion.heldQueue
      this.pendingQuestion = null
      this.post("user", "You", trimmed)
      this.notice("Question cancelled. Resuming pipeline.")
      this.queue = held
      this.aborted = false
      const paused = await this.drainQueue()
      if (paused) {
        this.hub.broadcast("workspace", await listWorkspace(config.workspaceDir))
        await this.saveCurrent()
        return
      }
      this.queue = []
      await this.endTurn()
      await this.saveCurrent()
      return
    }

    if (await this.handleSlashCommand(trimmed)) return

    // ── Resume from paused state ──────────────────────────────────────────
    if (this.pendingQuestion) {
      const pq = this.pendingQuestion
      this.pendingQuestion = null

      this.post("user", "You", trimmed, undefined, undefined, images)
      this.hub.broadcast("turn", { phase: "resume", askerId: pq.askerId })
      this.aborted = false

      // Force-route to the agent that asked the question.
      const asker = this.registry.get(pq.askerId)
      if (!asker || !asker.active) {
        this.notice(`@${pq.askerId} is no longer active — resuming held queue.`, "info")
        this.queue = pq.heldQueue
        const paused = await this.drainQueue()
        if (paused) {
          this.hub.broadcast("workspace", await listWorkspace(config.workspaceDir))
          await this.saveCurrent()
          return
        }
        this.queue = []
        await this.endTurn()
        await this.saveCurrent()
        return
      }

      // Use followUp() instead of runAgent() — the user's answer is delivered
      // directly to the agent that asked the question. The agent already has the
      // conversation context in its session memory; followUp() guarantees it's
      // the next thing the agent processes.
      const result = await this.followUpAgent(asker, { text: trimmed, images })
      if (result && !this.aborted) {
        // Post with question field if the asker asked another question.
        this.post(asker.persona.id, asker.persona.name, result.reply || "(no response)", result.activity, result.reasoning, undefined, result.question)
        if (receiptHasChanges(result.receipt)) this.hub.broadcast("receipt", result.receipt)
        asker.cursor = this.transcript.length

        // If the asker asked ANOTHER question, re-pause.
        if (result.question) {
          this.pendingQuestion = { askerId: asker.persona.id, heldQueue: pq.heldQueue }
          this.hub.broadcast("turn", { phase: "pause", askerId: asker.persona.id, question: result.question })
          this.hub.broadcast("workspace", await listWorkspace(config.workspaceDir))
          await this.saveCurrent()
          return
        }

        // Chain from asker's reply.
        if (this.chaining) {
          const next = this.resolveAgentMentions(result.reply, asker.persona.id)
          if (next.length > 0) {
            this.queue.push(...next)
            this.hub.broadcast("turn", { phase: "chain", from: asker.persona.id, targets: next.map((t) => t.persona.id) })
          }
        }
      }

      // Restore the held queue and continue draining.
      this.queue = pq.heldQueue
      const paused = await this.drainQueue()
      if (paused) {
        this.hub.broadcast("workspace", await listWorkspace(config.workspaceDir))
        await this.saveCurrent()
        return
      }
      this.queue = []
      await this.endTurn()
      await this.saveCurrent()
      return
    }

    // ── Normal (non-paused) flow ──────────────────────────────────────────
    this.post("user", "You", trimmed, undefined, undefined, images)

    const initial = this.resolveTargets(trimmed)
    if (initial.length === 0) {
      this.notice("No active participants to route to.", "info")
      return
    }

    this.queue = [...initial]
    this.aborted = false
    this.runningAgentId = initial[0]?.persona.id ?? null
    this.hub.broadcast("turn", { phase: "start", targets: initial.map((t) => t.persona.id), agentId: this.runningAgentId })

    // Drain the queue — shared method handles questions, chaining, and parallel waves.
    const paused = await this.drainQueue()
    if (paused) {
      this.hub.broadcast("workspace", await listWorkspace(config.workspaceDir))
      await this.saveCurrent()
      return
    }

    this.queue = []
    await this.endTurn()
    await this.saveCurrent()
  }

  /** Pull the next group off the queue: a contiguous run of parallel-flagged
   *  agents (a concurrent wave), or a single non-parallel agent (serial). */
  private nextGroup(): Participant[] {
    const first = this.queue.shift()!
    const group = [first]
    if (first.parallel) {
      while (this.queue.length > 0 && this.queue[0].parallel) group.push(this.queue.shift()!)
    }
    return group
  }

  /** The concurrency lane an agent runs on. Same-lane agents are serialized;
   *  different lanes run concurrently. All local models share one lane because
   *  llama-server runs --parallel 1; each cloud provider is its own lane. */
  private laneOf(p: Participant): string {
    const provider = p.persona.model ? p.persona.model.split("/")[0] : "local"
    return provider === "local" ? "local" : `cloud:${provider}`
  }

  /** Run a group concurrently. All members see the same pre-wave transcript.
   *  Per-lane serialization keeps local agents one-at-a-time; cloud agents on
   *  distinct endpoints run truly in parallel. Results come back in group order. */
  private async runWave(group: Participant[]): Promise<Array<RunOutput | null>> {
    const contexts = new Map(group.map((p) => [p, this.buildContext(p)]))
    const laneTail = new Map<string, Promise<unknown>>()

    return Promise.all(
      group.map((p) => {
        const ctx = contexts.get(p) ?? { text: "" }
        const task = () => this.runAgent(p, ctx)
        const lane = this.laneOf(p)
        // Local lane is single-slot: chain tasks so they never overlap.
        if (lane === "local") {
          const prev = laneTail.get(lane) ?? Promise.resolve()
          const result = prev.then(task)
          laneTail.set(lane, result.catch(() => {}))
          return result
        }
        // Cloud lanes: independent endpoints, run immediately/concurrently.
        return task()
      }),
    )
  }

  /** Run one agent end to end: snapshot, prompt, snapshot, diff. Does NOT post —
   *  the caller posts results in group order to keep the transcript deterministic. */
  private async runAgent(
    target: Participant,
    context: { text: string; images?: string[] },
  ): Promise<RunOutput | null> {
    const before = await snapshot(config.workspaceDir)
    this.running.add(target)
    try {
      const result = await target.run(context.text, context.images)
      if (this.aborted) return null
      const after = await snapshot(config.workspaceDir)

      // Broadcast context usage and session stats after the turn — piggyback on status event.
      // The idle status already fires from Participant.run() finally block;
      // this second broadcast adds contextUsage and sessionStats to the payload.
      const usage = target.getContextUsage?.()
      const stats = target.getSessionStats?.()
      if (usage || stats) {
        const payload: Record<string, unknown> = { id: target.persona.id, status: "idle" }
        if (usage) payload.contextUsage = usage
        if (stats) payload.sessionStats = stats
        this.hub.broadcast("status", payload)
      }

      return {
        target,
        reply: result.text,
        activity: result.activity,
        reasoning: result.reasoning,
        question: result.question,
        receipt: diffSnapshots(before, after, target.persona.id),
      }
    } catch (err) {
      this.notice(
        `@${target.persona.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      )
      target.cursor = this.transcript.length
      return null
    } finally {
      this.running.delete(target)
    }
  }

  /** Follow-up one agent end to end: snapshot, followUp, snapshot, diff.
   *  Same structure as runAgent but uses session.followUp() — guaranteed to be
   *  the next thing the agent processes. Used for self-chaining (ask_user resume).
   *  Does NOT post — the caller posts results. */
  private async followUpAgent(
    target: Participant,
    context: { text: string; images?: string[] },
  ): Promise<RunOutput | null> {
    const before = await snapshot(config.workspaceDir)
    this.running.add(target)
    try {
      const result = await target.followUp(context.text, context.images)
      if (this.aborted) return null
      const after = await snapshot(config.workspaceDir)

      const usage = target.getContextUsage?.()
      const stats = target.getSessionStats?.()
      if (usage || stats) {
        const payload: Record<string, unknown> = { id: target.persona.id, status: "idle" }
        if (usage) payload.contextUsage = usage
        if (stats) payload.sessionStats = stats
        this.hub.broadcast("status", payload)
      }

      return {
        target,
        reply: result.text,
        activity: result.activity,
        reasoning: result.reasoning,
        question: result.question,
        receipt: diffSnapshots(before, after, target.persona.id),
      }
    } catch (err) {
      this.notice(
        `@${target.persona.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      )
      target.cursor = this.transcript.length
      return null
    } finally {
      this.running.delete(target)
    }
  }

  /** Handle `/kick @x`, `/activate @x`, `/deactivate @x`. Returns true if handled. */
  private async handleSlashCommand(text: string): Promise<boolean> {
    if (!text.startsWith("/")) return false
    const [cmd, rawTarget] = text.split(/\s+/, 2)
    const id = rawTarget?.replace(/^@/, "").toLowerCase()

    switch (cmd) {
      case "/kick":
        if (id && this.registry.has(id)) {
          this.registry.kick(id)
          this.notice(`Kicked @${id}.`)
        } else this.notice(`/kick: unknown participant "${rawTarget ?? ""}".`, "error")
        return true
      case "/deactivate":
        if (id && this.registry.has(id)) {
          this.registry.setActive(id, false)
          this.notice(`Deactivated @${id}.`)
        } else this.notice(`/deactivate: unknown participant "${rawTarget ?? ""}".`, "error")
        return true
      case "/activate":
        if (id && this.registry.has(id)) {
          this.registry.setActive(id, true)
          this.notice(`Activated @${id}.`)
        } else this.notice(`/activate: unknown participant "${rawTarget ?? ""}".`, "error")
        return true
      case "/compact": {
        if (!id) {
          this.notice(`/compact: usage — /compact @agent`, "error")
          return true
        }
        const target = this.registry.get(id)
        if (!target) {
          this.notice(`/compact: unknown participant "${rawTarget ?? ""}".`, "error")
          return true
        }
        if (this.isBusy()) {
          this.notice(`/compact: wait until the current turn finishes.`, "error")
          return true
        }
        this.notice(`Compacting @${id}'s context…`)
        try {
          const result = await target.compact()
          this.notice(`@${id} compacted: ${result.tokensBefore} tokens before → summary generated.`)
        } catch (err) {
          this.notice(`/compact @${id} failed: ${err instanceof Error ? err.message : String(err)}`, "error")
        }
        return true
      }
      default:
        this.notice(`Unknown command "${cmd}".`, "error")
        return true
    }
  }

  /** Shared drain loop — replaces the 4 duplicated inline loops.
   *  Returns true if the pipeline was paused by an ask_user (caller should return).
   *  Handles parallel-wave questions correctly: posts ALL results from the wave
   *  before pausing on the first question, so no agent output is silently dropped. */
  private async drainQueue(): Promise<boolean> {
    while (this.queue.length > 0 && !this.aborted) {
      const group = this.nextGroup()
      if (group.length > 1) {
        this.notice(`running ${group.length} in parallel: ${group.map((g) => `@${g.persona.id}`).join(" ")}`)
        this.hub.broadcast("turn", { phase: "parallel", targets: group.map((g) => g.persona.id) })
      }

      const results = await this.runWave(group)

      // Collect which results have questions (we pause on the first one,
      // but still post ALL results from this wave to avoid data loss).
      let paused = false
      let pauseAskerId: string | null = null
      let pauseQuestion: string | null = null

      for (const out of results) {
        if (!out || this.aborted) continue

        if (out.question && !paused) {
          // First question in this wave — remember it, but don't return yet.
          paused = true
          pauseAskerId = out.target.persona.id
          pauseQuestion = out.question
        }

        // Post the result (with question field if applicable).
        this.post(out.target.persona.id, out.target.persona.name, out.reply || "(no response)", out.activity, out.reasoning, undefined, out.question)
        if (receiptHasChanges(out.receipt)) this.hub.broadcast("receipt", out.receipt)
        out.target.cursor = this.transcript.length

        // Chain from this reply (even if it had a question — the question is
        // posted as part of the message, so @mentions in the text still chain).
        if (this.chaining) {
          const next = this.resolveAgentMentions(out.reply, out.target.persona.id)
          if (next.length > 0) {
            this.queue.push(...next)
            this.hub.broadcast("turn", { phase: "chain", from: out.target.persona.id, targets: next.map((t) => t.persona.id) })
          }
        }
      }

      // If we encountered a question in this wave, pause now (after all wave results are posted).
      if (paused) {
        this.pendingQuestion = { askerId: pauseAskerId!, heldQueue: [...this.queue] }
        this.queue = []
        this.hub.broadcast("turn", { phase: "pause", askerId: pauseAskerId!, question: pauseQuestion! })
        return true
      }
    }
    return false
  }

  /** Stop everything: clear the pending queue and abort every running agent
   *  (a parallel wave can have several in flight at once). */
  async abortCurrent(): Promise<boolean> {
    this.aborted = true
    const had = this.queue.length > 0 || this.running.size > 0 || this.pendingQuestion !== null
    this.queue = []
    this.pendingQuestion = null
    await Promise.all([...this.running].map((p) => p.abort()))
    return had
  }
}
