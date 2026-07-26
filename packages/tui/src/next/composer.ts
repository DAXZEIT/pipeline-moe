// The team composer (/preset new|edit) — the biggest file in the migration, and
// the one that shrinks most.
//
// 613 lines of Ink become two pieces: a roster list (this file's own component,
// the same shape as the line-up editor) and a member card that is a `form.ts`
// declaration. Everything that was already framework-free stays where it is —
// `preset-composer.ts` owns `blankMember`, `duplicateMember`, `moveMember`,
// `teamStats`, `slugify`, `toPresetFile` and the cycles, and it is untouched
// except for the `ALL_TOOLS` move.
//
// THE SCREENS ARE OVERLAYS NOW, NOT `return`s.
//
// The Ink composer had three screens in one component and switched between them
// by returning a different element — `adding`, `editing`, `pickingModel` were
// booleans guarding early returns, and each one had to remember to pass
// `isActive: isActive && !thatOtherThing` so the layer underneath stopped reading
// the keyboard. With a real overlay stack the roster pushes the card, the card
// pushes the model picker, and pi-tui gives focus to the top and hands it back on
// hide. Three `isActive` conjunctions and the whole `picking`-style bookkeeping
// go away with them.
//
// What does NOT change: nothing is written to disk until `s` on the roster. The
// card edits a draft and hands the persona back; the roster holds the document.

import chalk from "chalk"
import { matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui"
import type { Api, ModelInfo, PersonaTemplate, PresetFile, PresetPersona, RoomStore } from "@pipeline-moe/client-core"
import { shortModel } from "../commands/registry"
import {
  PALETTE,
  THINKING_CYCLE,
  TOOL_GROUPS,
  VISION_CYCLE,
  backspaceText,
  blankMember,
  clonePersonas,
  cycle,
  duplicateMember,
  memberFromTemplate,
  moveMember,
  slugify,
  teamStats,
  toPresetFile,
  visionLabel,
} from "../preset-composer"
import { FormComponent, type FormRow, type Rows } from "./form"
import { fitLine, frame, moreMarker, twoColumn, windowStart } from "./overlay-frame"
import type { FormDeps } from "./forms"
import type { Overlay } from "../commands/types"

const CUSTOM = "custom…"

/* ── The member card ────────────────────────────────────────────────────────── */

/** One member, full card: identity, tools by group, brain, prompts, flags. Edits
 *  a local draft; Done (or esc) hands the persona back to the roster. Validation
 *  runs on the way out, so esc with a duplicate id keeps you in the card — the
 *  same rule the Ink version had. */
export function memberCard(
  persona: PresetPersona,
  siblingIds: string[],
  models: ModelInfo[],
  // No `onClose`: the card has no route that discards. Both esc and Done commit
  // through `onDone`, which is also what pops it — so there is no second door.
  deps: Omit<FormDeps, "onClose"> & { onDone: (p: PresetPersona) => void },
): FormComponent {
  // `color` comes off a preset document or a server-supplied persona template, so
  // it is only as reliable as whoever wrote that JSON. A missing one used to walk
  // straight into `.toLowerCase()`; here it just gets the first palette slot.
  const draft: PresetPersona = { ...persona, color: persona.color || PALETTE[0]!, tools: [...persona.tools] }
  let customModel = false
  let colorIdx = PALETTE.findIndex((c) => c.toLowerCase() === draft.color.toLowerCase())
  // -1 keeps a colour that is not in the palette rather than snapping to one.

  const refs = models.map((m) => m.ref)
  const modelOrder: (string | undefined)[] = [undefined, ...refs, CUSTOM]
  const modelCycle = (delta: number): void => {
    const cur = draft.model !== undefined && !refs.includes(draft.model) ? CUSTOM : draft.model
    const next = cycle(modelOrder, cur, delta)
    if (next === CUSTOM) {
      customModel = true
      draft.model = draft.model ?? ""
    } else {
      customModel = false
      draft.model = next
    }
  }

  const pickModel = (): void =>
    deps.openPicker({
      kind: "select",
      title: `Model for ${draft.icon} ${draft.name}`,
      items: [
        { id: "__default", label: "host default", hint: "no pin — process default" },
        ...models.map((m) => ({ id: m.ref, label: m.name, hint: m.local ? `${m.provider} · local` : m.provider })),
        { id: "__custom", label: CUSTOM, hint: "free provider/id" },
      ],
      onSelect: (id) => {
        if (id === "__custom") {
          customModel = true
          draft.model = draft.model ?? ""
        } else {
          customModel = false
          draft.model = id === "__default" ? undefined : id
        }
        deps.requestRender()
      },
    })

  const finish = (): void => {
    const id = slugify(draft.id || draft.name)
    if (!draft.name.trim()) return fail("Name is required.")
    if (!id) return fail("Id is required.")
    if (siblingIds.includes(id)) return fail(`Id "${id}" is already taken in this roster.`)
    // `skills: []` survives as an explicit opt-out (the hydration contract);
    // undefined keys are dropped by JSON.stringify on the wire.
    const skills = draft.skills === undefined ? undefined : draft.skills.map((s) => s.trim()).filter(Boolean)
    deps.onDone({
      ...draft,
      id,
      name: draft.name.trim(),
      icon: draft.icon.trim() || "🤖",
      skills,
      model: draft.model?.trim() || undefined,
      seat: draft.seat?.trim().toLowerCase() || undefined,
      systemPrompt: draft.systemPrompt?.trim() || undefined,
      compactionInstructions: draft.compactionInstructions?.trim() || undefined,
    })
  }

  const fail = (msg: string): void => {
    form.setError(msg)
    deps.requestRender()
  }

  const FLAGS = ["active", "parallel"]

  const form: FormComponent = new FormComponent(
    {
      title: () => `Member · ${chalk.hex(draft.color)(draft.icon)} ${draft.name || "(unnamed)"}`,
      color: "green",
      rows: (): FormRow[] => [
        { kind: "text", label: "name", get: () => draft.name, update: (f) => (draft.name = f(draft.name)) },
        {
          kind: "text",
          label: "id",
          get: () => draft.id,
          update: (f) => (draft.id = f(draft.id)),
          hint: () => `@${slugify(draft.id) || "?"}`,
        },
        { kind: "text", label: "emoji", get: () => draft.icon, update: (f) => (draft.icon = f(draft.icon)) },
        {
          kind: "cycle",
          label: "color",
          view: () => draft.color + (colorIdx === -1 ? " (custom)" : ""),
          swatch: () => draft.color,
          left: () => {
            colorIdx = colorIdx === -1 ? 0 : (colorIdx - 1 + PALETTE.length) % PALETTE.length
            draft.color = PALETTE[colorIdx]!
          },
          right: () => {
            colorIdx = colorIdx === -1 ? 0 : (colorIdx + 1) % PALETTE.length
            draft.color = PALETTE[colorIdx]!
          },
        },
        ...TOOL_GROUPS.map(
          (g): FormRow => ({
            kind: "chips",
            label: g.label,
            items: g.tools,
            on: (t) => draft.tools.includes(t),
            toggle: (t) => {
              draft.tools = draft.tools.includes(t) ? draft.tools.filter((x) => x !== t) : [...draft.tools, t]
            },
          }),
        ),
        customModel
          ? {
              kind: "text",
              label: "model",
              get: () => draft.model ?? "",
              update: (f) => (draft.model = f(draft.model ?? "")),
              // ⏎ leaves custom mode on the way out, so the row turns back into
              // the cycle rather than staying a text field forever.
              onEnter: () => (customModel = false),
              hint: () => "provider/id · ⏎ done",
            }
          : {
              kind: "cycle",
              label: "model",
              view: () => (draft.model === undefined ? "host default" : (shortModel(draft.model) ?? draft.model)),
              left: () => modelCycle(-1),
              right: () => modelCycle(+1),
              enter: pickModel,
              enterHint: "⏎ search catalogue",
            },
        {
          // Fused seats (docs/fused-seats.md): members typing the same seat share
          // ONE working context. Free text on purpose — a seat is a name you
          // invent ("maker"), not a catalogue pick.
          kind: "text",
          label: "seat",
          get: () => draft.seat ?? "",
          update: (f) => (draft.seat = f(draft.seat ?? "") || undefined),
          hint: () => "same seat = shared context · empty = own context",
        },
        {
          kind: "cycle",
          label: "thinking",
          view: () => draft.thinkingLevel ?? "inherit",
          left: () => (draft.thinkingLevel = cycle(THINKING_CYCLE, draft.thinkingLevel, -1)),
          right: () => (draft.thinkingLevel = cycle(THINKING_CYCLE, draft.thinkingLevel, +1)),
        },
        {
          kind: "cycle",
          label: "vision",
          view: () => visionLabel(draft.vision),
          left: () => (draft.vision = cycle(VISION_CYCLE, draft.vision, -1)),
          right: () => (draft.vision = cycle(VISION_CYCLE, draft.vision, +1)),
        },
        {
          kind: "text",
          label: "skills",
          get: () => (draft.skills ?? []).join(", "),
          // Edit the joined string and reparse; empty means inherit (undefined),
          // not opt-out, so trailing segments while typing "a, b" are fine.
          update: (f) => {
            const raw = f((draft.skills ?? []).join(", "))
            draft.skills = raw.trim() === "" ? undefined : raw.split(",").map((s) => s.trim())
          },
          hint: () => "comma-separated · empty = inherit",
        },
        {
          kind: "text",
          label: "prompt",
          long: true,
          get: () => draft.systemPrompt ?? "",
          update: (f) => (draft.systemPrompt = f(draft.systemPrompt ?? "") || undefined),
          hint: () => "empty = canonical prompt for this id",
        },
        {
          kind: "text",
          label: "compaction",
          long: true,
          get: () => draft.compactionInstructions ?? "",
          update: (f) => (draft.compactionInstructions = f(draft.compactionInstructions ?? "") || undefined),
        },
        {
          kind: "chips",
          label: "",
          items: FLAGS,
          on: (f) => (f === "active" ? draft.active : Boolean(draft.parallel)),
          toggle: (f) => {
            if (f === "active") draft.active = !draft.active
            else draft.parallel = draft.parallel ? undefined : true
          },
          accent: (f) => (f === "parallel" ? "cyan" : "green"),
        },
        { kind: "action", label: () => "Done" },
      ],
      // Both routes commit: the card is a draft editor, and esc meaning "discard
      // this member's edits" was never what the Ink version did either.
      onSubmit: finish,
      onCancel: finish,
      cancelHint: "esc/Done back to roster",
    },
    deps.rows,
  )
  return form
}

/* ── The roster screen ──────────────────────────────────────────────────────── */

export interface ComposerDeps extends FormDeps {
  /** Push a component the host did not build — the member card is ours, not one
   *  of the registry's `Overlay` kinds. Returns the function that pops IT, which
   *  is the distinction that keeps `onDone` from closing the composer. */
  openCard: (card: Component & Focusable) => () => void
}

/** The composer's roster: one condensed line per member, reorder / duplicate /
 *  delete, a team-stats footer, and the preset's name editable in the title.
 *  Saves the DOCUMENT via PUT /api/presets/:name — no live room is involved, so a
 *  team can be composed before any /newroom. */
export class ComposerComponent implements Component, Focusable {
  focused = false
  private name: string
  private personas: PresetPersona[]
  private cursor = 0
  private naming: boolean
  private confirmDiscard = false
  private error: string | null = null
  private models: ModelInfo[] = []
  private templates: PersonaTemplate[] = []

  constructor(
    private opts: {
      initial: PresetFile
      isNew: boolean
      api: Api
      store: RoomStore
      deps: ComposerDeps
    },
    private rows: Rows = () => process.stdout.rows ?? 24,
  ) {
    this.name = opts.initial.name
    this.personas = clonePersonas(opts.initial.personas)
    this.naming = opts.isNew && !opts.initial.name
    // Both lists are garnish: no models → the model field still cycles host
    // default and custom; no templates → `a` still offers a blank member.
    void opts.api
      .models()
      .then(({ models }) => {
        this.models = models
        opts.deps.requestRender()
      })
      .catch(() => {})
    void opts.api
      .personaTemplates()
      .then((t) => {
        this.templates = t
        opts.deps.requestRender()
      })
      .catch(() => {})
  }

  invalidate(): void {}

  private addMember(member: PresetPersona): void {
    const at = this.personas.length
    this.personas = [...this.personas, member]
    this.cursor = at
    this.editMember(at)
  }

  private editMember(i: number): void {
    const p = this.personas[i]
    if (!p) return
    this.error = null
    // `pop` is assigned by openCard below, and only ever called from onDone —
    // which cannot run before the card is on screen and has taken a keystroke.
    let pop: (() => void) | null = null
    const card = memberCard(
      p,
      this.personas.filter((_, j) => j !== i).map((x) => x.id),
      this.models,
      {
        openPicker: this.opts.deps.openPicker,
        requestRender: this.opts.deps.requestRender,
        rows: this.rows,
        onDone: (edited) => {
          this.personas = this.personas.map((x, j) => (j === i ? edited : x))
          pop?.()
          this.opts.deps.requestRender()
        },
      },
    )
    pop = this.opts.deps.openCard(card)
  }

  private save(): void {
    if (!this.name.trim()) {
      this.naming = true
      this.error = "Name the preset first."
      return
    }
    if (this.personas.length === 0) {
      this.error = "Add at least one member."
      return
    }
    const { api, store, deps } = this.opts
    api
      .savePresetDoc(toPresetFile(this.name.trim(), this.personas, this.opts.initial))
      .then(({ preset, warnings }) => {
        store.pushNotice(`Preset "${preset.name}" saved (${preset.personas.length} members).`)
        for (const w of warnings) store.pushNotice(w.message, "error")
        deps.onClose()
      })
      .catch((err: unknown) => {
        this.error = err instanceof Error && err.message ? err.message : "Save failed — server unreachable?"
        deps.requestRender()
      })
  }

  handleInput(data: string): void {
    const { deps } = this.opts
    if (matchesKey(data, "escape")) {
      if (this.naming) {
        this.naming = false
        return
      }
      // Two presses to discard. A composed team is minutes of work and esc is
      // one key away from every other key in this screen.
      if (this.confirmDiscard) return deps.onClose()
      this.confirmDiscard = true
      return
    }
    this.confirmDiscard = false

    if (this.naming) {
      if (matchesKey(data, "enter")) {
        this.naming = false
        return
      }
      if (matchesKey(data, "backspace")) {
        this.name = backspaceText(this.name)
        return
      }
      // A preset name becomes a filename on the server; narrow it at the source.
      const clean = data.replace(/[^a-zA-Z0-9_-]/g, "")
      if (clean) {
        this.error = null
        this.name += clean
      }
      return
    }

    const n = this.personas.length
    if (matchesKey(data, "up")) {
      this.cursor = n === 0 ? 0 : (this.cursor - 1 + n) % n
      return
    }
    if (matchesKey(data, "down")) {
      this.cursor = n === 0 ? 0 : (this.cursor + 1) % n
      return
    }
    if (matchesKey(data, "enter")) {
      if (n > 0) this.editMember(this.cursor)
      return
    }
    if (data === "a") {
      // Template picker first — a team is mostly assembled from roles the app
      // already knows, and "blank" stays one ⏎ away as the top entry.
      if (this.templates.length > 0) this.pickTemplate()
      else this.addMember(blankMember(this.personas))
      return
    }
    if (data === "d" && n > 0) {
      this.personas = duplicateMember(this.personas, this.cursor)
      this.cursor += 1
      return
    }
    if (data === "x" && n > 0) {
      this.personas = this.personas.filter((_, i) => i !== this.cursor)
      this.cursor = Math.max(0, Math.min(this.cursor, n - 2))
      return
    }
    if ((data === "K" || data === "J") && n > 0) {
      const { list, index } = moveMember(this.personas, this.cursor, data === "K" ? -1 : +1)
      this.personas = list
      this.cursor = index
      return
    }
    if (data === "r") {
      this.naming = true
      return
    }
    if (data === "s") this.save()
  }

  private pickTemplate(): void {
    const o: Overlay = {
      kind: "select",
      title: "Add member",
      items: [
        { id: "__blank", label: "＋ blank member", hint: "from scratch" },
        ...this.templates.map((t) => ({
          id: t.id,
          label: `${t.icon} ${t.name}`,
          hint: `${t.tools.length} tools${t.model ? ` · ${shortModel(t.model)}` : ""}`,
        })),
      ],
      onSelect: (id) => {
        const t = this.templates.find((x) => x.id === id)
        this.addMember(t ? memberFromTemplate(t, this.personas) : blankMember(this.personas))
      },
    }
    this.opts.deps.openPicker(o)
  }

  render(width: number): string[] {
    const inner = width - 4
    const n = this.personas.length
    // The roster is one line per member, so the same budget arithmetic as a form:
    // 80% of the screen less the frame, the markers, the stats line and any error.
    const visible = Math.max(3, Math.floor(this.rows() * 0.8) - 7 - (this.error ? 1 : 0))
    const cursor = Math.min(this.cursor, Math.max(0, n - 1))
    const start = windowStart(cursor, n, visible)
    const end = Math.min(start + visible, n)

    const body: string[] = []
    if (n === 0) {
      body.push(chalk.dim("Empty roster — press a to add a member."))
    } else {
      body.push(moreMarker(start > 0, "▲"))
      for (let i = start; i < end; i++) {
        const p = this.personas[i]!
        const cur = i === cursor && !this.naming
        const left = cur
          ? chalk.magenta.inverse(`▶ ${p.icon} ${p.id}`)
          : `  ${chalk.hex(p.color)(p.icon)} ${p.id}`
        const right =
          chalk.dim(
            `${p.seat ? `⌐${p.seat} · ` : ""}${p.thinkingLevel ?? "inherit"} · ${shortModel(p.model) ?? "host default"} · ${p.tools.length} tools `,
          ) +
          (p.active ? chalk.green("●") : chalk.gray("○")) +
          (p.parallel ? chalk.cyan("∥") : " ")
        body.push(twoColumn(left, right, inner))
      }
      body.push(moreMarker(end < n, "▼"))
      body.push(chalk.dim(teamStats(this.personas)))
    }
    if (this.error) body.push(fitLine(chalk.red(this.error), inner))

    return frame(
      {
        title: `${this.opts.isNew ? "New preset" : "Edit preset"}: ${
          this.naming ? this.name + chalk.green("▌") : this.name || chalk.dim("(unnamed)")
        }`,
        titleRight: n > visible ? `${cursor + 1}/${n}` : undefined,
        body,
        hint: this.confirmDiscard
          ? "esc again to discard changes · any key to stay"
          : this.naming
            ? "type the preset name · ⏎ done · esc cancel"
            : "⏎ edit · a add · d dup · x del · K/J move · r rename · s save · esc discard",
        color: "magenta",
      },
      width,
    )
  }
}
