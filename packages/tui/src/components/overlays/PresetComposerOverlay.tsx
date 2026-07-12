import { Box, Text, useInput } from "ink"
import { useEffect, useMemo, useState } from "react"
import type { Api, ModelInfo, PersonaTemplate, PresetFile, PresetPersona, RoomStore } from "@pipeline-moe/client-core"
import { shortModel } from "../../commands/registry"
import { SelectOverlay } from "./SelectOverlay"
import {
  backspaceText,
  blankMember,
  clonePersonas,
  cycle,
  duplicateMember,
  memberFromTemplate,
  moveMember,
  PALETTE,
  slugify,
  teamStats,
  THINKING_CYCLE,
  TOOL_GROUPS,
  toPresetFile,
  VISION_CYCLE,
  visionLabel,
} from "../../preset-composer"

/**
 * The team composer (/preset new|edit) — the full persona card of the web
 * builder folded into terminal idioms: a roster screen (one condensed line
 * per member, reorder/duplicate/delete, team stats footer) and a member
 * screen (the card, one section per field group). Screens stack: ⏎ dives
 * into a member, esc surfaces back to the roster; esc from the roster asks
 * once before discarding. Edits a preset DOCUMENT via PUT /api/presets/:name
 * — no live room is involved, so a team can be composed before any /newroom.
 */
export function PresetComposerOverlay({
  initial,
  isNew,
  api,
  store,
  onClose,
  isActive,
}: {
  initial: PresetFile
  isNew: boolean
  api: Api
  store: RoomStore
  onClose: () => void
  isActive: boolean
}) {
  const [name, setName] = useState(initial.name)
  const [personas, setPersonas] = useState<PresetPersona[]>(() => clonePersonas(initial.personas))
  const [cursor, setCursor] = useState(0)
  const [editing, setEditing] = useState<number | null>(null)
  const [naming, setNaming] = useState(isNew && !initial.name)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [templates, setTemplates] = useState<PersonaTemplate[]>([])
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    // Both lists are garnish: no models → the model field still cycles host
    // default/custom; no templates → `a` still offers a blank member.
    api
      .models()
      .then(({ models }) => setModels(models))
      .catch(() => {})
    api
      .personaTemplates()
      .then(setTemplates)
      .catch(() => {})
  }, [api])

  const addMember = (member: PresetPersona) => {
    setAdding(false)
    setPersonas((list) => [...list, member])
    setCursor(personas.length)
    setEditing(personas.length)
  }

  const save = () => {
    if (!name.trim()) {
      setNaming(true)
      setError("Name the preset first.")
      return
    }
    if (personas.length === 0) {
      setError("Add at least one member.")
      return
    }
    api
      .savePresetDoc(toPresetFile(name.trim(), personas, initial))
      .then(({ preset, warnings }) => {
        store.pushNotice(`Preset "${preset.name}" saved (${preset.personas.length} members).`)
        for (const w of warnings) store.pushNotice(w.message, "error")
        onClose()
      })
      .catch((err: unknown) =>
        setError(err instanceof Error && err.message ? err.message : "Save failed — server unreachable?"),
      )
  }

  useInput(
    (input, key) => {
      if (editing !== null) return // the member screen owns the keyboard
      if (key.escape) {
        if (naming) return setNaming(false)
        if (confirmDiscard) return onClose()
        setConfirmDiscard(true)
        return
      }
      setConfirmDiscard(false)
      if (naming) {
        if (key.return) {
          setNaming(false)
          return
        }
        if (key.backspace || key.delete) return setName((v) => backspaceText(v))
        if (key.ctrl || key.meta) return
        const clean = input.replace(/[^a-zA-Z0-9_-]/g, "")
        if (clean) {
          setError(null)
          setName((v) => v + clean)
        }
        return
      }
      const n = personas.length
      if (key.upArrow) return setCursor((c) => (n === 0 ? 0 : (c - 1 + n) % n))
      if (key.downArrow) return setCursor((c) => (n === 0 ? 0 : (c + 1) % n))
      if (key.return) {
        if (n === 0) return
        setError(null)
        return setEditing(cursor)
      }
      if (input === "a") {
        // Template picker first (blank stays one ⏎ away as the top entry) —
        // a team is mostly assembled from the roles the app already knows.
        if (templates.length > 0) setAdding(true)
        else addMember(blankMember(personas))
        return
      }
      if (input === "d" && n > 0) {
        setPersonas(duplicateMember(personas, cursor))
        setCursor(cursor + 1)
        return
      }
      if (input === "x" && n > 0) {
        setPersonas(personas.filter((_, i) => i !== cursor))
        setCursor((c) => Math.max(0, Math.min(c, n - 2)))
        return
      }
      if (input === "K" && n > 0) {
        const { list, index } = moveMember(personas, cursor, -1)
        setPersonas(list)
        setCursor(index)
        return
      }
      if (input === "J" && n > 0) {
        const { list, index } = moveMember(personas, cursor, +1)
        setPersonas(list)
        setCursor(index)
        return
      }
      if (input === "r") return setNaming(true)
      if (input === "s") return save()
    },
    { isActive: isActive && editing === null && !adding },
  )

  if (adding) {
    return (
      <SelectOverlay
        title="Add member"
        items={[
          { id: "__blank", label: "＋ blank member", hint: "from scratch" },
          ...templates.map((t) => ({
            id: t.id,
            label: `${t.icon} ${t.name}`,
            hint: `${t.tools.length} tools${t.model ? ` · ${shortModel(t.model)}` : ""}`,
          })),
        ]}
        isActive={isActive}
        onCancel={() => setAdding(false)}
        onSelect={(id) => {
          const t = templates.find((x) => x.id === id)
          addMember(t ? memberFromTemplate(t, personas) : blankMember(personas))
        }}
      />
    )
  }

  if (editing !== null && personas[editing]) {
    return (
      <MemberEditor
        persona={personas[editing]}
        siblingIds={personas.filter((_, i) => i !== editing).map((p) => p.id)}
        models={models}
        isActive={isActive}
        onDone={(p) => {
          setPersonas((list) => list.map((x, i) => (i === editing ? p : x)))
          setEditing(null)
        }}
      />
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta" bold>
        {isNew ? "New preset" : "Edit preset"}
        {": "}
        {naming ? (
          <Text>
            {name}
            <Text color="green">▌</Text>
          </Text>
        ) : (
          <Text>{name || "(unnamed)"}</Text>
        )}
      </Text>
      {personas.length === 0 ? <Text dimColor>Empty roster — press a to add a member.</Text> : null}
      {personas.map((p, i) => {
        const cur = i === cursor && !naming
        return (
          <Box key={`${p.id}-${i}`} justifyContent="space-between">
            <Text color={cur ? "magenta" : undefined} inverse={cur} wrap="truncate-end">
              {cur ? "▶ " : "  "}
              <Text color={p.color}>{p.icon} </Text>
              {p.id}
            </Text>
            <Text dimColor wrap="truncate-end">
              {" "}
              {p.seat ? `⌐${p.seat} · ` : ""}
              {p.thinkingLevel ?? "inherit"} · {shortModel(p.model) ?? "host default"} · {p.tools.length} tools{" "}
              <Text color={p.active ? "green" : "gray"}>{p.active ? "●" : "○"}</Text>
              <Text color="cyan">{p.parallel ? "∥" : " "}</Text>
            </Text>
          </Box>
        )
      })}
      <Text dimColor>{teamStats(personas)}</Text>
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>
        {confirmDiscard
          ? "esc again to discard changes · any key to stay"
          : naming
            ? "type the preset name · ⏎ done · esc cancel"
            : "⏎ edit · a add · d dup · x del · K/J move · r rename · s save · esc discard"}
      </Text>
    </Box>
  )
}

// ── Screen B — the member card ──────────────────────────────────────────────

const CUSTOM = "custom…"

type Row =
  /** `update` MUST route through a functional setState: a pasted emoji can
   *  arrive as two stdin events in one tick, and a read-then-set against the
   *  render-scope draft loses the first half (found live: 🐺 → lone
   *  surrogate). `get` is display-only. */
  | { kind: "text"; label: string; get: () => string; update: (fn: (v: string) => string) => void; hint?: string }
  | { kind: "cycle"; label: string; view: () => string; left: () => void; right: () => void }
  | { kind: "tools"; label: string; tools: string[] }
  | { kind: "flags" }
  | { kind: "done" }

/** One member, full card: IDENTITY / TOOLS / BRAIN / PROMPTS / FLAGS. Local
 *  draft state; Done hands the edited persona back to the roster screen —
 *  nothing is saved to disk until the roster's s. */
function MemberEditor({
  persona,
  siblingIds,
  models,
  isActive,
  onDone,
}: {
  persona: PresetPersona
  siblingIds: string[]
  models: ModelInfo[]
  isActive: boolean
  onDone: (p: PresetPersona) => void
}) {
  const [draft, setDraft] = useState<PresetPersona>(() => ({ ...persona, tools: [...persona.tools] }))
  const [focus, setFocus] = useState(0)
  const [toolCursor, setToolCursor] = useState(0)
  const [flagCursor, setFlagCursor] = useState(0)
  const [customModel, setCustomModel] = useState(false)
  const [pickingModel, setPickingModel] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [colorIdx, setColorIdx] = useState(() => {
    const i = PALETTE.findIndex((c) => c.toLowerCase() === persona.color.toLowerCase())
    return i === -1 ? -1 : i // -1: keep a color that isn't in the palette
  })

  const patch = (p: Partial<PresetPersona>) => {
    setError(null)
    setDraft((d) => ({ ...d, ...p }))
  }

  /** Functional field update — reads the CURRENT draft, not the render's. */
  const upd = (f: (d: PresetPersona) => Partial<PresetPersona>) => {
    setError(null)
    setDraft((d) => ({ ...d, ...f(d) }))
  }

  // Model cycle (quick ←→ adjust): host default (undefined) → each configured
  // model → custom…. The real catalogue lives behind ⏎: a searchable picker,
  // same interaction as /model — a 300-model list is not arrow-key territory.
  const refs = useMemo(() => models.map((m) => m.ref), [models])
  const modelOrder = useMemo<(string | undefined)[]>(() => [undefined, ...refs, CUSTOM], [refs])
  const modelCycle = (delta: number) => {
    const cur = draft.model !== undefined && !refs.includes(draft.model) ? CUSTOM : draft.model
    const next = cycle(modelOrder, cur, delta)
    if (next === CUSTOM) {
      setCustomModel(true)
      patch({ model: draft.model ?? "" })
    } else {
      setCustomModel(false)
      patch({ model: next })
    }
  }

  const rows: Row[] = [
    { kind: "text", label: "name", get: () => draft.name, update: (fn) => upd((d) => ({ name: fn(d.name) })) },
    {
      kind: "text",
      label: "id",
      get: () => draft.id,
      update: (fn) => upd((d) => ({ id: fn(d.id) })),
      hint: `@${slugify(draft.id) || "?"}`,
    },
    { kind: "text", label: "emoji", get: () => draft.icon, update: (fn) => upd((d) => ({ icon: fn(d.icon) })) },
    {
      kind: "cycle",
      label: "color",
      view: () => draft.color + (colorIdx === -1 ? " (custom)" : ""),
      left: () => {
        const i = colorIdx === -1 ? 0 : (colorIdx - 1 + PALETTE.length) % PALETTE.length
        setColorIdx(i)
        patch({ color: PALETTE[i] })
      },
      right: () => {
        const i = colorIdx === -1 ? 0 : (colorIdx + 1) % PALETTE.length
        setColorIdx(i)
        patch({ color: PALETTE[i] })
      },
    },
    ...TOOL_GROUPS.map((g): Row => ({ kind: "tools", label: g.label, tools: g.tools })),
    customModel
      ? {
          kind: "text",
          label: "model",
          get: () => draft.model ?? "",
          update: (fn) => upd((d) => ({ model: fn(d.model ?? "") })),
          hint: "provider/id · ⏎ done",
        }
      : {
          kind: "cycle",
          label: "model",
          view: () => (draft.model === undefined ? "host default" : (shortModel(draft.model) ?? draft.model)),
          left: () => modelCycle(-1),
          right: () => modelCycle(+1),
        },
    {
      // Fused seats (docs/fused-seats.md): members typing the same seat share
      // ONE working context — several roles on a single model. Free text on
      // purpose: a seat is a name you invent ("maker"), not a catalogue pick.
      kind: "text",
      label: "seat",
      get: () => draft.seat ?? "",
      update: (fn) => upd((d) => ({ seat: fn(d.seat ?? "") || undefined })),
      hint: "same seat = shared context · empty = own context",
    },
    {
      kind: "cycle",
      label: "thinking",
      view: () => draft.thinkingLevel ?? "inherit",
      left: () => patch({ thinkingLevel: cycle(THINKING_CYCLE, draft.thinkingLevel, -1) }),
      right: () => patch({ thinkingLevel: cycle(THINKING_CYCLE, draft.thinkingLevel, +1) }),
    },
    {
      kind: "cycle",
      label: "vision",
      view: () => visionLabel(draft.vision),
      left: () => patch({ vision: cycle(VISION_CYCLE, draft.vision, -1) }),
      right: () => patch({ vision: cycle(VISION_CYCLE, draft.vision, +1) }),
    },
    {
      kind: "text",
      label: "skills",
      get: () => (draft.skills ?? []).join(", "),
      update: (fn) =>
        upd((d) => {
          // Edit the joined string, reparse; empty = inherit (undefined),
          // not opt-out — trailing segments while typing "a, b" are fine.
          const raw = fn((d.skills ?? []).join(", "))
          return { skills: raw.trim() === "" ? undefined : raw.split(",").map((s) => s.trim()) }
        }),
      hint: "comma-separated · empty = inherit",
    },
    {
      kind: "text",
      label: "prompt",
      get: () => draft.systemPrompt ?? "",
      update: (fn) => upd((d) => ({ systemPrompt: fn(d.systemPrompt ?? "") || undefined })),
      hint: "empty = canonical prompt for this id",
    },
    {
      kind: "text",
      label: "compaction",
      get: () => draft.compactionInstructions ?? "",
      update: (fn) => upd((d) => ({ compactionInstructions: fn(d.compactionInstructions ?? "") || undefined })),
    },
    { kind: "flags" },
    { kind: "done" },
  ]

  const finish = () => {
    const id = slugify(draft.id || draft.name)
    if (!draft.name.trim()) return setError("Name is required.")
    if (!id) return setError("Id is required.")
    if (siblingIds.includes(id)) return setError(`Id "${id}" is already taken in this roster.`)
    // `skills: []` survives as an explicit opt-out (hydration contract);
    // undefined keys are dropped by JSON.stringify on the wire.
    const skills = draft.skills === undefined ? undefined : draft.skills.map((s) => s.trim()).filter(Boolean)
    onDone({
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

  useInput(
    (input, key) => {
      const row = rows[focus]
      if (key.escape) return finish()
      if (key.upArrow) return setFocus((f) => (f - 1 + rows.length) % rows.length)
      if (key.downArrow || key.tab) return setFocus((f) => (f + 1) % rows.length)
      if (key.return) {
        if (row.kind === "done") return finish()
        if (row.kind === "text" && row.label === "model") setCustomModel(false)
        // The model row's ⏎ opens the searchable catalogue instead of moving
        // on — ←→ still cycles for quick adjustments.
        if (row.kind === "cycle" && row.label === "model") return setPickingModel(true)
        return setFocus((f) => Math.min(rows.length - 1, f + 1))
      }
      if (row.kind === "cycle") {
        if (key.leftArrow) return row.left()
        if (key.rightArrow) return row.right()
        return
      }
      if (row.kind === "tools") {
        const n = row.tools.length
        if (key.leftArrow) return setToolCursor((c) => (c - 1 + n) % n)
        if (key.rightArrow) return setToolCursor((c) => (c + 1) % n)
        if (input === " ") {
          const t = row.tools[Math.min(toolCursor, n - 1)]
          patch({ tools: draft.tools.includes(t) ? draft.tools.filter((x) => x !== t) : [...draft.tools, t] })
        }
        return
      }
      if (row.kind === "flags") {
        if (key.leftArrow || key.rightArrow) return setFlagCursor((c) => (c + 1) % 2)
        if (input === " ") {
          if (flagCursor === 0) patch({ active: !draft.active })
          else patch({ parallel: draft.parallel ? undefined : true })
        }
        return
      }
      if (row.kind !== "text") return
      if (key.backspace || key.delete) return row.update(backspaceText)
      if (key.ctrl || key.meta) return
      if (input) {
        const clean = input.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "")
        if (clean) row.update((v) => v + clean)
      }
    },
    { isActive: isActive && !pickingModel },
  )

  const caret = <Text color="green">▌</Text>
  const marker = (i: number) => (
    <Text color={i === focus ? "green" : undefined}>{i === focus ? "▶ " : "  "}</Text>
  )

  if (pickingModel) {
    return (
      <SelectOverlay
        title={`Model for ${draft.icon} ${draft.name}`}
        items={[
          { id: "__default", label: "host default", hint: "no pin — process default" },
          ...models.map((m) => ({
            id: m.ref,
            label: m.name,
            hint: m.local ? `${m.provider} · local` : m.provider,
          })),
          { id: "__custom", label: CUSTOM, hint: "free provider/id" },
        ]}
        isActive={isActive}
        onCancel={() => setPickingModel(false)}
        onSelect={(id) => {
          setPickingModel(false)
          if (id === "__custom") {
            setCustomModel(true)
            patch({ model: draft.model ?? "" })
          } else {
            setCustomModel(false)
            patch({ model: id === "__default" ? undefined : id })
          }
        }}
      />
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Text color="green" bold>
        Member · <Text color={draft.color}>{draft.icon} </Text>
        {draft.name || "(unnamed)"}
      </Text>
      {rows.map((row, i) => {
        if (row.kind === "text") {
          const long = row.label === "prompt" || row.label === "compaction"
          const val = row.get()
          const shown = long && i !== focus && val.length > 60 ? val.slice(0, 57) + "…" : val
          return (
            <Box key={row.label}>
              {marker(i)}
              <Text dimColor>{row.label}: </Text>
              <Text wrap="truncate-end">
                {shown}
                {i === focus ? caret : null}
              </Text>
              {row.hint ? <Text dimColor> {row.hint}</Text> : null}
            </Box>
          )
        }
        if (row.kind === "cycle") {
          const focused = i === focus
          const swatch = row.label === "color"
          return (
            <Box key={row.label}>
              {marker(i)}
              <Text dimColor>{row.label}: </Text>
              <Text color={swatch ? draft.color : undefined}>
                {focused ? "‹ " : ""}
                {swatch ? "■■ " : ""}
                {row.view()}
                {focused ? " ›" : ""}
              </Text>
            </Box>
          )
        }
        if (row.kind === "tools") {
          const focused = i === focus
          return (
            <Box key={row.label}>
              {marker(i)}
              <Text dimColor>{row.label.padEnd(5)} </Text>
              <Box flexWrap="wrap" flexGrow={1}>
                {row.tools.map((t, j) => {
                  const on = draft.tools.includes(t)
                  const cur = focused && j === Math.min(toolCursor, row.tools.length - 1)
                  return (
                    <Text key={t} inverse={cur} color={on ? "green" : undefined} dimColor={!on && !cur}>
                      {on ? "■" : "□"}
                      {t}
                      {"  "}
                    </Text>
                  )
                })}
              </Box>
            </Box>
          )
        }
        if (row.kind === "flags") {
          const focused = i === focus
          return (
            <Box key="flags">
              {marker(i)}
              <Text inverse={focused && flagCursor === 0} color={draft.active ? "green" : undefined}>
                {draft.active ? "■" : "□"}active
              </Text>
              <Text> </Text>
              <Text inverse={focused && flagCursor === 1} color={draft.parallel ? "cyan" : undefined}>
                {draft.parallel ? "■" : "□"}parallel
              </Text>
            </Box>
          )
        }
        return (
          <Box key="done" marginTop={1}>
            <Text inverse={i === focus} color={i === focus ? "green" : "gray"}>
              {i === focus ? "▶ " : "  "}[ Done ]
            </Text>
          </Box>
        )
      })}
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>
        {rows[focus]?.kind === "cycle" && rows[focus]?.label === "model"
          ? "⏎ search catalogue · ←→ quick cycle · ↑↓ field · esc/Done back to roster"
          : "↑↓ field · ←→ cycle/tool · space toggle · ⏎ next · esc/Done back to roster"}
      </Text>
    </Box>
  )
}
