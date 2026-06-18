// The participant registry: the live roster of agents. Create / activate /
// deactivate / kick all happen here. Emits a "roster" SSE event on any change.

import { Participant } from "./participant.js"
import type { ResolvedModel } from "./model.js"
import type { SseHub } from "./sse.js"
import type { Persona, PersonaState } from "./types.js"

export interface RosterItem {
  id: string
  name: string
  color: string
  icon: string
  tools: string[]
  active: boolean
  status: string
  /** Per-agent model "provider/id", or undefined when on the default. */
  model?: string
  /** Per-agent thinking level, or undefined when inheriting from global config. */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  /** May run concurrently with adjacent parallel-flagged agents. */
  parallel: boolean
}

export class Registry {
  private participants = new Map<string, Participant>()
  /** Fired after any roster mutation (create/activate/kick). Used for autosave. */
  onChange: (() => void) | null = null

  constructor(
    private readonly resolved: ResolvedModel,
    private readonly hub: SseHub,
  ) {}

  /** Participants that should take part in the loop, in insertion order. */
  activeParticipants(): Participant[] {
    return [...this.participants.values()].filter((p) => p.active)
  }

  /** Snapshot of the roster as personas + runtime flags, for persistence. */
  personaStates(): PersonaState[] {
    return [...this.participants.values()].map((p) => ({
      ...p.persona,
      active: p.active,
      parallel: p.parallel,
    }))
  }

  get(id: string): Participant | undefined {
    return this.participants.get(id)
  }

  has(id: string): boolean {
    return this.participants.has(id)
  }

  roster(): RosterItem[] {
    return [...this.participants.values()].map((p) => ({
      id: p.persona.id,
      name: p.persona.name,
      color: p.persona.color,
      icon: p.persona.icon,
      tools: p.persona.tools,
      active: p.active,
      status: p.status,
      model: p.persona.model,
      thinkingLevel: p.persona.thinkingLevel,
      parallel: p.parallel,
    }))
  }

  broadcastRoster(): void {
    this.hub.broadcast("roster", this.roster())
  }

  async create(persona: Persona, active = true, parallel = false): Promise<Participant> {
    if (this.participants.has(persona.id)) {
      throw new Error(`participant "${persona.id}" already exists`)
    }
    const participant = await Participant.create(persona, this.resolved, (event, data) =>
      this.hub.broadcast(event, data),
    )
    // Catch a new participant up on everything said so far before its first turn.
    participant.cursor = 0
    participant.active = active
    participant.parallel = parallel
    this.participants.set(persona.id, participant)
    this.broadcastRoster()
    this.onChange?.()
    return participant
  }

  /** Editable persona fields (id is immutable — it is the @mention handle). */
  async update(
    id: string,
    patch: Partial<Pick<Persona, "name" | "color" | "icon" | "tools" | "systemPrompt" | "model" | "thinkingLevel">>,
  ): Promise<Participant> {
    const existing = this.participants.get(id)
    if (!existing) throw new Error(`unknown participant "${id}"`)
    const order = [...this.participants.keys()]
    const wasActive = existing.active
    const persona: Persona = { ...existing.persona, ...patch, id }

    // A new system prompt = a new identity, so we rebuild the pi session now
    // rather than mutating the running one. cursor=0 → it replays the room
    // transcript on its next turn with the new persona.
    existing.dispose()
    const replacement = await Participant.create(persona, this.resolved, (event, data) =>
      this.hub.broadcast(event, data),
    )
    replacement.cursor = 0
    replacement.active = wasActive

    // Rebuild the Map in the original order (a plain set() would move it last,
    // reordering @all / first-active routing).
    const rebuilt = new Map<string, Participant>()
    for (const key of order) {
      rebuilt.set(key, key === id ? replacement : this.participants.get(key)!)
    }
    this.participants = rebuilt

    this.broadcastRoster()
    this.onChange?.()
    return replacement
  }

  /** Reorder the roster to match the given id sequence. This is the first-turn /
   *  @all execution order (and the first-active fallback default). Ids not listed
   *  keep their relative order, appended after the listed ones. No session is
   *  recreated — only references move — so it is safe to call mid-turn. */
  reorder(orderedIds: string[]): void {
    const seen = new Set<string>()
    const next: string[] = []
    for (const id of orderedIds) {
      if (this.participants.has(id) && !seen.has(id)) {
        next.push(id)
        seen.add(id)
      }
    }
    for (const id of this.participants.keys()) if (!seen.has(id)) next.push(id)

    const rebuilt = new Map<string, Participant>()
    for (const id of next) rebuilt.set(id, this.participants.get(id)!)
    this.participants = rebuilt

    this.broadcastRoster()
    this.onChange?.()
  }

  setActive(id: string, active: boolean): Participant {
    const p = this.participants.get(id)
    if (!p) throw new Error(`unknown participant "${id}"`)
    p.active = active
    p.status = "idle"
    this.broadcastRoster()
    this.onChange?.()
    return p
  }

  /** Toggle whether an agent may run concurrently. Pure runtime flag — no
   *  session recreation, so it is safe to flip anytime (takes effect next turn). */
  setParallel(id: string, parallel: boolean): Participant {
    const p = this.participants.get(id)
    if (!p) throw new Error(`unknown participant "${id}"`)
    p.parallel = parallel
    this.broadcastRoster()
    this.onChange?.()
    return p
  }

  /** In-place thinking level change — no session recreation. Takes effect next turn. */
  async setThinkingLevel(
    id: string,
    level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
  ): Promise<Participant> {
    const p = this.participants.get(id)
    if (!p) throw new Error(`unknown participant "${id}"`)
    await p.setThinkingLevel(level)
    this.broadcastRoster()
    this.onChange?.()
    return p
  }

  kick(id: string): void {
    const p = this.participants.get(id)
    if (!p) throw new Error(`unknown participant "${id}"`)
    p.dispose()
    this.participants.delete(id)
    this.broadcastRoster()
    this.onChange?.()
  }

  /** Replace the whole roster with a saved persona set (fresh pi sessions).
   *  Used when loading/switching conversations. Does not fire onChange. */
  async reset(states: PersonaState[]): Promise<void> {
    const cb = this.onChange
    this.onChange = null // suppress per-participant autosave during a bulk swap
    try {
      for (const p of this.participants.values()) p.dispose()
      this.participants.clear()
      for (const s of states) {
        const { active, parallel, ...persona } = s
        await this.create(persona, active, parallel ?? false)
      }
    } finally {
      this.onChange = cb
    }
    this.broadcastRoster()
  }

  disposeAll(): void {
    for (const p of this.participants.values()) p.dispose()
    this.participants.clear()
  }
}
