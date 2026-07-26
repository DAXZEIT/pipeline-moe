// The three wizards — new agent, edit agent, new room — as declarations.
//
// Each one used to be a React component carrying its own copy of the keyboard
// loop, its own row rendering and its own `useState` set: 197 + 206 + 326 = 729
// lines. What is left here is what was actually SPECIFIC to each: which fields
// exist, what they validate, and which API call submits them. The loop, the
// windowing, the chip wrapping and the box all live in `form.ts`.
//
// State is plain mutable locals in a closure. No hooks means no stale-closure
// hazard — the `update: (fn) => …` contract in `form.ts` exists because Ink's
// functional-setState rule was easy to get wrong, and here `v => v + chunk`
// against a local is simply correct. It also means the async loads (edit-agent's
// participant fetch, the room form's presets and models) just assign and ask for
// a render, instead of a `useEffect` with a dependency array.
//
// THE ROOM FORM IS WHERE THE `picking` HACK DIES. The Ink version faked a second
// modal level by returning a `<SelectOverlay>` INSTEAD of itself and keeping its
// state mounted underneath — 60 lines of that file were the workaround. pi-tui
// stacks overlays for real, so the picker is pushed ON TOP of the form and the
// form is still on screen behind it. `openPicker` is the host's `push`, not its
// `open`: replacing would destroy the form we are picking a value for.

import chalk from "chalk"
import type { Api, ModelInfo, PresetFile, RoomStore } from "@pipeline-moe/client-core"
import { shortModel } from "../commands/registry"
import { ALL_TOOLS, DEFAULT_TOOLS, PALETTE } from "../preset-composer"
import { presetSummary, previewPersonas, roomFormPreviewMax } from "../preset-picker"
import { FormComponent, type FormRow, type Rows } from "./form"
import type { Overlay } from "../commands/types"

/** What every form needs from the client: a way to raise a picker ON TOP of
 *  itself, a way to take itself down, and the terminal height. */
export interface FormDeps {
  /** Pushes onto the overlay stack — the form stays visible underneath, and the
   *  host pops the picker on select or cancel. */
  openPicker: (o: Overlay) => void
  /** Close THIS overlay — the host pops the layer this form is on, not the whole
   *  stack. The member card's `onDone` and the roster's `s` both need that
   *  distinction, and getting it wrong closes the composer instead of the card. */
  onClose: () => void
  requestRender: () => void
  rows?: Rows
}

/* ── New agent ──────────────────────────────────────────────────────────────── */

/** Create-agent wizard (/agent). Submits through `store.actions.createParticipant`
 *  — the server broadcasts the new roster, so there is no local roster write. */
export function agentForm(store: RoomStore, deps: FormDeps): FormComponent {
  let name = ""
  let systemPrompt = ""
  let icon = ""
  let tools = [...DEFAULT_TOOLS]

  const form: FormComponent = new FormComponent(
    {
      title: () => "New agent",
      color: "green",
      rows: (): FormRow[] => [
        { kind: "text", label: "Name", placeholder: "e.g. Reviewer", get: () => name, update: (f) => (name = f(name)) },
        {
          kind: "text",
          label: "System prompt",
          placeholder: "what this agent is for",
          get: () => systemPrompt,
          update: (f) => (systemPrompt = f(systemPrompt)),
        },
        {
          kind: "chips",
          label: "Tools",
          items: ALL_TOOLS,
          on: (t) => tools.includes(t),
          toggle: (t) => (tools = tools.includes(t) ? tools.filter((x) => x !== t) : [...tools, t]),
        },
        { kind: "text", label: "Icon", placeholder: "single emoji, optional", get: () => icon, update: (f) => (icon = f(icon)) },
        { kind: "action", label: () => "Create" },
      ],
      onSubmit: () => {
        if (!name.trim() || !systemPrompt.trim()) {
          form.setError("Name and system prompt are required.")
          deps.requestRender()
          return
        }
        store.actions
          .createParticipant({
            name: name.trim(),
            systemPrompt: systemPrompt.trim(),
            tools,
            ...(icon.trim() ? { icon: icon.trim() } : {}),
          })
          .then(() => {
            store.pushNotice(`Agent "${name.trim()}" created.`)
            deps.onClose()
          })
          // A swallowed rejection leaves Create looking like it did nothing.
          .catch((err: unknown) => {
            form.setError(err instanceof Error && err.message ? err.message : "Create failed — server unreachable?")
            deps.requestRender()
          })
      },
      onCancel: () => deps.onClose(),
    },
    deps.rows,
  )
  return form
}

/* ── Edit agent ─────────────────────────────────────────────────────────────── */

/** Edit an existing agent's identity — name, icon, colour, tools (model and
 *  thinking level have their own commands, the system prompt has /prompt).
 *  Pre-filled from the persona detail; Save PATCHes identity fields only.
 *
 *  The colour palette puts the agent's CURRENT colour in slot 0, so "leave it
 *  alone" is the position the cycle starts at. */
export function editAgentForm(agentId: string, store: RoomStore, deps: FormDeps): FormComponent {
  let loaded = false
  let name = ""
  let icon = ""
  let colors: string[] = [...PALETTE]
  let colorIdx = 0
  let tools: string[] = []

  const form: FormComponent = new FormComponent(
    {
      title: () => `Edit agent · @${agentId}`,
      color: "green",
      rows: (): FormRow[] =>
        !loaded
          ? [{ kind: "note", lines: () => [chalk.dim("Loading…")] }]
          : [
              { kind: "text", label: "Name", get: () => name, update: (f) => (name = f(name)) },
              { kind: "text", label: "Icon", get: () => icon, update: (f) => (icon = f(icon)) },
              {
                kind: "cycle",
                label: "Color",
                view: () => colors[colorIdx]! + (colorIdx === 0 ? " (current)" : ""),
                swatch: () => colors[colorIdx],
                left: () => (colorIdx = (colorIdx - 1 + colors.length) % colors.length),
                right: () => (colorIdx = (colorIdx + 1) % colors.length),
              },
              {
                kind: "chips",
                label: "Tools",
                items: ALL_TOOLS,
                on: (t) => tools.includes(t),
                toggle: (t) => (tools = tools.includes(t) ? tools.filter((x) => x !== t) : [...tools, t]),
              },
              { kind: "action", label: () => "Save" },
            ],
      onSubmit: () => {
        if (!loaded) return
        if (!name.trim()) {
          form.setError("Name is required.")
          deps.requestRender()
          return
        }
        store.actions
          .updateParticipant(agentId, {
            name: name.trim(),
            color: colors[colorIdx]!,
            tools,
            ...(icon.trim() ? { icon: icon.trim() } : {}),
          })
          .then(() => {
            store.pushNotice(`@${agentId} updated.`)
            deps.onClose()
          })
          .catch((err: unknown) => {
            form.setError(err instanceof Error && err.message ? err.message : "Save failed — server unreachable?")
            deps.requestRender()
          })
      },
      onCancel: () => deps.onClose(),
    },
    deps.rows,
  )

  store.actions
    .getParticipant(agentId)
    .then((d) => {
      name = d.name
      icon = d.icon
      // Current colour first, deduped; the palette after. Index 0 = unchanged.
      colors = [d.color, ...PALETTE.filter((c) => c.toLowerCase() !== d.color.toLowerCase())]
      colorIdx = 0
      tools = d.tools
      loaded = true
      deps.requestRender()
    })
    .catch(() => {
      form.setError("Failed to load the agent.")
      deps.requestRender()
    })

  return form
}

/* ── New room ───────────────────────────────────────────────────────────────── */

// Roster-cycle slots ahead of the saved presets: the default team, or a solo room
// (a bare pi — /solo's form twin). Solo swaps the preset preview for a Model row,
// because the model IS the choice there.
const DEFAULT_IDX = 0
const SOLO_IDX = 1

export interface RoomFormDeps extends FormDeps {
  /** Told about the created room so the client can refresh its tab strip. */
  onCreated: (roomId: string, name: string, hadGoal: boolean) => void
}

/** Create-room wizard (/newroom, or the "+ room" tab): name, roster, optional
 *  working directory (a local path, or user@host:/path mounted over SSHFS) and an
 *  optional goal — a goal auto-starts the room.
 *
 *  ←→ cycles the roster for a quick pick; ⏎ pushes the full picker on top, which
 *  is the interaction a list of thirty presets or three hundred models needs. */
export function roomForm(api: Api, deps: RoomFormDeps): FormComponent {
  let nameV = ""
  let workspaceDir = ""
  let goal = ""
  let presets: PresetFile[] = []
  let presetIdx = DEFAULT_IDX
  let models: ModelInfo[] = []
  let modelIdx = 0 // 0 = the server's default model
  let busy = false

  const presetLabels = (): string[] => ["— default roster —", "— solo: pure pi —", ...presets.map((p) => p.name)]
  const solo = (): boolean => presetIdx === SOLO_IDX
  const selectedPreset = (): PresetFile | undefined => (presetIdx > SOLO_IDX ? presets[presetIdx - 2] : undefined)
  const modelLabels = (): string[] => ["— default model —", ...models.map((m) => `${m.local ? "🖥 " : "☁ "}${m.name}`)]
  const modelRef = (): string | undefined => (modelIdx > 0 ? models[modelIdx - 1]?.ref : undefined)
  const rowsRef = deps.rows ?? ((): number => process.stdout.rows ?? 24)

  const pickPreset = (): void =>
    deps.openPicker({
      kind: "select",
      title: "Roster for the new room",
      // Ids are indices into presetLabels(), so the two sentinel rows and a
      // preset literally named "1" can never collide.
      items: [
        { id: String(DEFAULT_IDX), label: `${presetIdx === DEFAULT_IDX ? "● " : "  "}— default roster —`, hint: "the server's default team" },
        { id: String(SOLO_IDX), label: `${solo() ? "● " : "  "}— solo: pure pi —`, hint: "a bare pi, no team scaffolding" },
        ...presets.map((p, i) => ({
          id: String(i + 2),
          label: `${presetIdx === i + 2 ? "● " : "  "}${p.name}`,
          hint: presetSummary(p),
        })),
      ],
      onSelect: (id) => {
        presetIdx = Number(id)
        deps.requestRender()
      },
    })

  const pickModel = (): void =>
    deps.openPicker({
      kind: "select",
      title: "Model for the solo pi",
      items: [
        { id: "", label: `${modelIdx === 0 ? "● " : "  "}Room default`, hint: "the server's default model" },
        ...models.map((m) => ({
          id: m.ref,
          label: `${m.ref === modelRef() ? "● " : "  "}${m.local ? "🖥 " : "☁ "}${m.name}`,
          hint: m.provider,
        })),
      ],
      emptyText: "No models reported by the server.",
      onSelect: (ref) => {
        modelIdx = ref ? models.findIndex((m) => m.ref === ref) + 1 : 0
        deps.requestRender()
      },
    })

  const previewRows = (): FormRow[] => {
    if (solo()) {
      return [
        { kind: "note", lines: () => [chalk.dim("    a bare pi — full tools, no team scaffolding")] },
        {
          kind: "cycle",
          label: "Model",
          view: () => modelLabels()[modelIdx] ?? "— default model —",
          left: () => (modelIdx = (modelIdx - 1 + modelLabels().length) % modelLabels().length),
          right: () => (modelIdx = (modelIdx + 1) % modelLabels().length),
          enter: pickModel,
          enterHint: "⏎ pick model",
        },
      ]
    }
    // The same per-agent preview the Presets overlay shows (icon + name, model,
    // tools) — picking a preset here shows WHAT is about to spawn, not just a name.
    const { shown, hidden } = previewPersonas(selectedPreset(), roomFormPreviewMax(rowsRef()))
    if (shown.length === 0) return []
    return [
      {
        kind: "note",
        lines: () => [
          ...shown.map(
            (p) =>
              "    " +
              chalk.hex(p.color)(`${p.icon} ${p.name}`) +
              "  " +
              chalk.cyan(shortModel(p.model) ?? "default") +
              (p.tools.length ? chalk.dim("  " + p.tools.join(" ")) : ""),
          ),
          ...(hidden > 0 ? [chalk.dim(`      … +${hidden} more agents`)] : []),
        ],
      },
    ]
  }

  const form: FormComponent = new FormComponent(
    {
      title: () => "New room",
      color: "green",
      rows: (): FormRow[] => [
        {
          kind: "text",
          label: "Name",
          placeholder: solo() ? "optional — auto-named solo/<model>" : "e.g. Cloud Sprint",
          get: () => nameV,
          update: (f) => (nameV = f(nameV)),
        },
        {
          kind: "cycle",
          label: "Preset",
          view: () => {
            const label = presetLabels()[presetIdx] ?? "— default roster —"
            const p = selectedPreset()
            if (p) return `${label}  ${presetSummary(p)}`
            if (presets.length === 0 && !solo()) return `${label}  (no saved presets)`
            return label
          },
          left: () => (presetIdx = (presetIdx - 1 + presetLabels().length) % presetLabels().length),
          right: () => (presetIdx = (presetIdx + 1) % presetLabels().length),
          enter: pickPreset,
          enterHint: "⏎ pick roster",
        },
        ...previewRows(),
        {
          kind: "text",
          label: "Workdir",
          placeholder: "optional — /path or user@host:/path (SSHFS)",
          get: () => workspaceDir,
          update: (f) => (workspaceDir = f(workspaceDir)),
        },
        {
          kind: "text",
          label: "Goal",
          placeholder: "optional — auto-starts the room",
          get: () => goal,
          update: (f) => (goal = f(goal)),
        },
        { kind: "action", label: () => (busy ? "Creating…" : "Create room") },
      ],
      onSubmit: () => {
        if (busy) return
        const name = nameV.trim()
        // Solo rooms may go nameless — the server derives "solo/<model>".
        if (!name && !solo()) {
          form.setError("Name is required.")
          deps.requestRender()
          return
        }
        busy = true
        deps.requestRender()
        api
          .createRoom({
            name,
            ...(solo() ? { solo: true, ...(modelRef() ? { model: modelRef()! } : {}) } : selectedPreset() ? { preset: selectedPreset()!.name } : {}),
            ...(workspaceDir.trim() ? { workspaceDir: workspaceDir.trim() } : {}),
            ...(goal.trim() ? { goal: goal.trim() } : {}),
          })
          .then((room) => {
            deps.onClose()
            // room.name, not the typed name — solo auto-names on empty input.
            deps.onCreated(room.roomId, room.name, Boolean(goal.trim()))
          })
          .catch((err: unknown) => {
            busy = false
            form.setError(err instanceof Error && err.message ? err.message : "Create failed — server unreachable?")
            deps.requestRender()
          })
      },
      onCancel: () => deps.onClose(),
    },
    deps.rows,
  )

  // Both lists are garnish: no presets → the cycle still offers default and solo;
  // no models → the Model row still cycles the server default.
  void api
    .presets()
    .then((p) => {
      presets = p
      deps.requestRender()
    })
    .catch(() => {})
  void api
    .models()
    .then((r) => {
      models = r.models
      deps.requestRender()
    })
    .catch(() => {})

  return form
}
