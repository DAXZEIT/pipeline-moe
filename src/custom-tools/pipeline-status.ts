// pipeline_status — the observation half of an orchestrator seat.
//
// An agent holding spawn_room can command the pipeline but, until this tool,
// could not SEE it: check_room needs an id it can only have by having spawned
// the room itself, preset names had to be guessed, and neither the model list
// nor the local slot was reachable from a turn. Commanding without observing
// makes the routing decision this seat exists for ("local is saturated, put
// this one on cloud") unmakeable. See docs/orchestrator-room.md.
//
// One tool rather than list_rooms / list_presets / list_models: that decision
// needs all three facts at once, so three tools is three round trips for one
// thought — and small models call whatever they are shown (the scribe's
// spurious task_update, 2026-07-12), so three extra names on the menu is three
// extra ways to answer "what now?" with a listing.

import { Type } from "typebox"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { PipelineStatus, RoomOrchestrator } from "../orchestrator.js"

const pipelineStatusSchema = Type.Object({})

/** Cloud refs listed per provider before collapsing into a count. A live run
 *  with PIPELINE_ALLOW_CLOUD on printed ~100 refs (anthropic + huggingface
 *  catalogues) — several thousand tokens of menu injected into a local seat's
 *  context to answer "is there a cloud model". Local models are never sampled:
 *  there are a handful and they are the ones that contend for the slot. */
const CLOUD_SAMPLE = 5

/** Goal text is free-form and may be a paragraph; the table is one row per room. */
const GOAL_WIDTH = 80

/** Pad to a column width without truncating: an over-long room name should
 *  break alignment, not lose characters the agent needs to address it. */
function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length)
}

/** Flatten to one line and bound the width — a multi-line goal would otherwise
 *  break every row below it. */
function oneLine(s: string, width: number): string {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > width ? flat.slice(0, width - 1) + "…" : flat
}

/** Render the census as an aligned text table. Text over JSON, same reasoning
 *  as check_room: this is read by a model, not parsed by a client. */
export function renderPipelineStatus(s: PipelineStatus, currentRoomId?: string): string {
  const lines: string[] = []

  lines.push(`ROOMS (${s.rooms.length}/${s.maxRooms})`)
  if (s.rooms.length === 0) {
    lines.push("  (none)")
  } else {
    const idW = Math.max(...s.rooms.map((r) => r.roomId.length))
    for (const r of s.rooms) {
      const goal = r.goalText ? `${r.goalStatus} — ${oneLine(r.goalText, GOAL_WIDTH)}` : r.goalStatus
      const cols = [
        `  ${pad(r.roomId, idW)}`,
        pad(`roster ${r.participantCount}`, 10),
        `goal: ${goal}`,
      ]
      let line = cols.join("  ")
      if (r.workspaceDir) line += `   ${r.workspaceDir}`
      if (r.roomId === currentRoomId) line += "   ← you"
      lines.push(line)
    }
  }

  const { capacity, inUse, holders, waiting } = s.local
  const free = capacity - inUse
  const held = holders.length > 0 ? ` — held by ${holders.join(", ")}` : ""
  const queued = waiting > 0 ? `, ${waiting} waiting` : ""
  lines.push("")
  lines.push(
    `LOCAL SLOTS: ${inUse}/${capacity} in use${held}${queued}` +
      (free > 0 ? "" : " — a new local room will QUEUE behind these"),
  )

  lines.push("")
  lines.push("MODELS")
  const local = s.models.filter((m) => m.local)
  const cloud = s.models.filter((m) => !m.local)
  if (s.models.length === 0) {
    lines.push("  (none available)")
  } else {
    const modelW = local.length > 0 ? Math.max(...local.map((m) => m.ref.length)) : 0
    for (const m of local) lines.push(`  ${pad(m.ref, modelW)}  local`)
    // Cloud is a catalogue, not a roster: sample it per provider so the section
    // stays a decision aid rather than a dump.
    const byProvider = new Map<string, string[]>()
    for (const m of cloud) {
      const slash = m.ref.indexOf("/")
      const key = slash > 0 ? m.ref.slice(0, slash) : m.ref
      byProvider.set(key, [...(byProvider.get(key) ?? []), m.ref])
    }
    for (const [provider, refs] of byProvider) {
      lines.push(`  ${provider}/ — ${refs.length} cloud models:`)
      for (const ref of refs.slice(0, CLOUD_SAMPLE)) lines.push(`    ${ref}`)
      if (refs.length > CLOUD_SAMPLE) lines.push(`    … +${refs.length - CLOUD_SAMPLE} more`)
    }
    if (cloud.length === 0) lines.push("  (no cloud model available — every room competes for the local slots)")
  }

  lines.push("")
  lines.push("PRESETS")
  if (s.presets.length === 0) {
    lines.push("  (none — spawn_room without a preset uses the default roster)")
  }
  const presetW = s.presets.length > 0 ? Math.max(...s.presets.map((p) => p.name.length)) : 0
  for (const p of s.presets) {
    lines.push(`  ${pad(p.name, presetW)}  ${p.agents.length} agents   ${p.agents.join(", ")}`)
  }

  return lines.join("\n")
}

export function createPipelineStatusToolDefinition(
  orchestrator: RoomOrchestrator,
  currentRoomId?: string,
): ToolDefinition<typeof pipelineStatusSchema, undefined> {
  return {
    name: "pipeline_status",
    label: "Pipeline Status",
    description:
      "Census of the whole pipeline: every room with its roster size and goal, how many rooms may " +
      "still be created, local-model slot occupancy, the models you may assign, and the preset " +
      "rosters spawn_room accepts. Read-only. Call this BEFORE spawn_room — it is the only way to " +
      "learn a preset name, to reach a room you did not spawn yourself, and to see whether the " +
      "local model is saturated (if it is, spawn on a cloud model instead of queueing behind it). " +
      "Local models are listed in full; cloud providers are sampled.",
    parameters: pipelineStatusSchema,
    execute: async () => {
      const s = await orchestrator.pipelineStatus()
      return {
        content: [{ type: "text", text: renderPipelineStatus(s, currentRoomId) }],
        details: undefined,
      }
    },
  }
}
