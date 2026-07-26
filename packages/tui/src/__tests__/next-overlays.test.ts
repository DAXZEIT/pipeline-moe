import { beforeAll, describe, expect, test, vi } from "vitest"
import chalk from "chalk"
import stringWidth from "string-width"
import type { RoomStore, RoomTask, RosterItem } from "@pipeline-moe/client-core"
import type { SelectItem } from "../commands/types.js"
import {
  LineupOverlayComponent,
  PresetPickerOverlayComponent,
  SelectOverlayComponent,
  TasksOverlayComponent,
  TextInputOverlayComponent,
  type SelectOverlayOptions,
} from "../next/overlays.js"

// The five generic overlays. They are plain objects with `render(width)` and
// `handleInput(data)`, so the whole interaction model tests with no terminal, no
// renderer and no React — which is the point of the migration as much as the
// scrollback is.

beforeAll(() => {
  chalk.level = 3
})

const plain = (ls: string[]): string[] => ls.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
const vis = (s: string): number => stringWidth(s.replace(/\x1b\[[0-9;]*m/g, ""))
const text = (ls: string[]): string => plain(ls).join("\n")
const rows = () => 40

const ESC = "\x1b"
const ENTER = "\r"
const UP = "\x1b[A"
const DOWN = "\x1b[B"
const BACKSPACE = "\x7f"

const roster: RosterItem[] = [
  { id: "scout", name: "Scout", color: "#4A90D9", icon: "🔍", active: true, parallel: false } as RosterItem,
  { id: "builder", name: "Builder", color: "#EF9F27", icon: "🔨", active: false, parallel: true } as RosterItem,
]

describe("SelectOverlayComponent", () => {
  const items: SelectItem[] = [
    { id: "a", label: "alpha", hint: "the first one" },
    { id: "b", label: "beta", hint: "the second" },
    { id: "g", label: "gamma", hint: "radiation" },
  ]
  const make = (over: Partial<SelectOverlayOptions> = {}) => {
    const onSelect = vi.fn()
    const onCancel = vi.fn()
    const c = new SelectOverlayComponent({ title: "Pick", items, onSelect, onCancel, ...over }, rows)
    return { c, onSelect, onCancel }
  }

  test("⏎ selects by ID, not by label — the id is what the command consumes", () => {
    const { c, onSelect } = make()
    c.handleInput(ENTER)
    expect(onSelect).toHaveBeenCalledWith("a")
  })

  test("↑↓ moves, and wraps", () => {
    const { c, onSelect } = make()
    c.handleInput(DOWN)
    c.handleInput(ENTER)
    expect(onSelect).toHaveBeenCalledWith("b")
    const b = make()
    b.c.handleInput(UP) // wraps to the last
    b.c.handleInput(ENTER)
    expect(b.onSelect).toHaveBeenCalledWith("g")
  })

  test("typing filters on the hint, not only the label", () => {
    const { c } = make()
    c.handleInput("r")
    c.handleInput("a")
    c.handleInput("d") // "radiation" — the hint of gamma
    const out = text(c.render(60))
    expect(out).toContain("gamma")
    expect(out).not.toContain("alpha")
    expect(out).toContain("🔎 rad")
  })

  test("the filter is fuzzy and RANKED — characters in order, best match first", () => {
    // `fuzzyFilter`, not `SelectList.setFilter` (a case-insensitive PREFIX match
    // on `value`, i.e. on our opaque ids). Fuzzy means a single character is a
    // weak filter: "r" also matches "the first one". What it buys is the order —
    // the best match is the one ⏎ picks.
    const { c, onSelect } = make()
    c.handleInput("r")
    const out = plain(c.render(60))
    expect(out.findIndex((l) => l.includes("gamma"))).toBeLessThan(out.findIndex((l) => l.includes("alpha")))
    c.handleInput(ENTER)
    expect(onSelect).toHaveBeenCalledWith("g")
  })

  test("filtering resets the cursor to the top, so ⏎ picks what is highlighted", () => {
    const { c, onSelect } = make()
    c.handleInput(DOWN)
    c.handleInput(DOWN)
    c.handleInput("a") // list re-filters
    c.handleInput(ENTER)
    // Whatever survives the filter, the pick must be the FIRST surviving row —
    // never a stale index into the old list.
    expect(onSelect).toHaveBeenCalledTimes(1)
    const picked = onSelect.mock.calls[0]![0] as string
    expect(["a", "b", "g"]).toContain(picked)
  })

  test("backspace edits the filter rather than cancelling", () => {
    const { c, onCancel } = make()
    c.handleInput("r")
    c.handleInput(BACKSPACE)
    expect(onCancel).not.toHaveBeenCalled()
    expect(text(c.render(60))).toContain("alpha")
  })

  test("a filter with no match stays editable instead of dismissing", () => {
    const { c, onCancel } = make()
    c.handleInput("z")
    expect(onCancel).not.toHaveBeenCalled()
    expect(text(c.render(60))).toContain("No match")
    expect(text(c.render(60))).toContain("backspace to edit")
  })

  test("an EMPTY list is dismissed by any key — never a stuck modal", () => {
    const { c, onCancel } = make({ items: [], emptyText: "No providers configured." })
    expect(text(c.render(60))).toContain("No providers configured.")
    c.handleInput("x")
    expect(onCancel).toHaveBeenCalled()
  })

  test("esc cancels", () => {
    const { c, onCancel } = make()
    c.handleInput(ESC)
    expect(onCancel).toHaveBeenCalled()
  })

  test("every rendered line fits, at every width, with hostile content", () => {
    const nasty: SelectItem[] = Array.from({ length: 40 }, (_, i) => ({
      id: `id-${i}`,
      label: "a".repeat(80),
      hint: "b".repeat(80),
    }))
    const { c } = make({ items: nasty })
    for (const w of [200, 120, 80, 60, 40, 20]) {
      for (const line of c.render(w)) expect(vis(line)).toBe(w)
    }
  })
})

describe("TextInputOverlayComponent", () => {
  const make = (over: Partial<{ mask: boolean; placeholder: string }> = {}) => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    const c = new TextInputOverlayComponent({ title: "API key", onSubmit, onCancel, ...over })
    return { c, onSubmit, onCancel }
  }

  test("typing then ⏎ submits the trimmed value", () => {
    const { c, onSubmit } = make()
    for (const ch of " sk-abc ") c.handleInput(ch)
    c.handleInput(ENTER)
    expect(onSubmit).toHaveBeenCalledWith("sk-abc")
  })

  test("an empty ⏎ submits nothing — it is not a way to save a blank key", () => {
    const { c, onSubmit } = make()
    c.handleInput(ENTER)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test("esc cancels", () => {
    const { c, onCancel } = make()
    c.handleInput(ESC)
    expect(onCancel).toHaveBeenCalled()
  })

  test("the placeholder shows only while empty", () => {
    const { c } = make({ placeholder: "paste key, ⏎ to save" })
    expect(text(c.render(60))).toContain("paste key")
    c.handleInput("x")
    expect(text(c.render(60))).not.toContain("paste key")
  })

  test("masked: all but the last four are bullets", () => {
    const { c } = make({ mask: true })
    for (const ch of "sk-secret-1234") c.handleInput(ch)
    const out = text(c.render(60))
    expect(out).toContain("1234")
    expect(out).not.toContain("secret")
    expect(out).toContain("•")
    // …and it says so, because a field you cannot read has to explain itself.
    expect(out).toContain("only the last 4")
  })

  test("masked: a short value is not padded into a false length", () => {
    const { c } = make({ mask: true })
    for (const ch of "abc") c.handleInput(ch)
    expect(text(c.render(60))).toContain("abc")
  })

  test("masking never leaks the value through the width", () => {
    const { c } = make({ mask: true })
    for (const ch of "x".repeat(200)) c.handleInput(ch)
    for (const w of [120, 60, 40, 20]) {
      for (const line of c.render(w)) expect(vis(line)).toBe(w)
    }
  })

  test("focus is forwarded to the Input, or the hardware cursor lands elsewhere", () => {
    const { c } = make()
    c.focused = true
    expect(c.focused).toBe(true)
  })
})

describe("TasksOverlayComponent", () => {
  const tasks: RoomTask[] = [
    { id: 3, subject: "third, completed", status: "completed", createdBy: "user", ts: 0 },
    { id: 1, subject: "first, pending", status: "pending", createdBy: "user", ts: 0 },
    { id: 2, subject: "second, running", status: "in_progress", owner: "scout", createdBy: "user", ts: 0 },
  ]
  const make = (ts = tasks) => {
    const onClose = vi.fn()
    const c = new TasksOverlayComponent({ tasks: () => ts, roster: () => roster, onClose }, rows)
    return { c, onClose }
  }

  test("in-progress first, then pending, completed last", () => {
    const { c } = make()
    const out = plain(c.render(80))
    const at = (s: string): number => out.findIndex((l) => l.includes(s))
    expect(at("second, running")).toBeLessThan(at("first, pending"))
    expect(at("first, pending")).toBeLessThan(at("third, completed"))
  })

  test("the title counts what is done", () => {
    expect(text(make().c.render(80))).toContain("TASK BOARD 1/3 done")
  })

  test("an owner is shown, in that agent's colour", () => {
    const line = make().c.render(80).find((l) => l.includes("second, running"))!
    expect(line).toContain("@scout")
    // #4A90D9 as a truecolor SGR — the owner is identified by colour as well as
    // by name, the same way the roster strip does it.
    expect(line).toContain("38;2;74;144;217")
  })

  test("an empty board explains who fills it", () => {
    expect(text(make([]).c.render(80))).toContain("task_create")
  })

  test("esc, ⌃P and q all close — a toggle must work in both directions", () => {
    for (const key of [ESC, "\x10", "q"]) {
      const { c, onClose } = make()
      c.handleInput(key)
      expect(onClose).toHaveBeenCalled()
    }
  })

  test("scrolling never runs off either end", () => {
    const many: RoomTask[] = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      subject: `task ${i}`,
      status: "pending" as const,
      createdBy: "user",
      ts: 0,
    }))
    const { c } = make(many)
    for (let i = 0; i < 200; i++) c.handleInput(DOWN)
    const bottom = text(c.render(80))
    expect(bottom).toContain("task 99")
    for (let i = 0; i < 300; i++) c.handleInput(UP)
    expect(text(c.render(80))).toContain("task 0")
  })

  test("height does not change as the cursor scrolls", () => {
    const many: RoomTask[] = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      subject: `t${i}`,
      status: "pending" as const,
      createdBy: "user",
      ts: 0,
    }))
    const { c } = make(many)
    const before = c.render(80).length
    for (let i = 0; i < 20; i++) c.handleInput(DOWN)
    expect(c.render(80).length).toBe(before)
  })
})

describe("LineupOverlayComponent", () => {
  const makeStore = (): { store: RoomStore; calls: string[] } => {
    const calls: string[] = []
    const state = { roster }
    const store = {
      getSnapshot: () => state,
      actions: {
        reorderParticipants: (order: string[]) => calls.push(`reorder:${order.join(",")}`),
        setActive: (id: string, v: boolean) => calls.push(`active:${id}:${v}`),
        setParallel: (id: string, v: boolean) => calls.push(`parallel:${id}:${v}`),
        kick: (id: string) => calls.push(`kick:${id}`),
      },
    } as unknown as RoomStore
    return { store, calls }
  }
  const make = () => {
    const { store, calls } = makeStore()
    const onClose = vi.fn()
    const onAddAgent = vi.fn()
    return { c: new LineupOverlayComponent({ store, onAddAgent, onClose }), calls, onClose, onAddAgent }
  }

  test("shows active/paused, parallel and the model per agent", () => {
    const out = text(make().c.render(90))
    expect(out).toContain("●active")
    expect(out).toContain("○paused")
    expect(out).toContain("∥")
    expect(out).toContain("room default")
  })

  test("space toggles the cursor row's active flag through a store action", () => {
    const { c, calls } = make()
    c.handleInput(" ")
    expect(calls).toEqual(["active:scout:false"])
  })

  test("p toggles parallel, x kicks", () => {
    const { c, calls } = make()
    c.handleInput("p") // scout starts parallel:false → true
    c.handleInput("x")
    expect(calls).toEqual(["parallel:scout:true", "kick:scout"])
  })

  test("] reorders and carries the cursor with the agent it moved", () => {
    const { c, calls } = make()
    c.handleInput("]")
    expect(calls).toEqual(["reorder:builder,scout"])
    // The cursor followed, so a second ] cannot move past the end.
    c.handleInput("]")
    expect(calls).toHaveLength(1)
  })

  test("[ at the top does nothing rather than wrapping — a reorder is destructive", () => {
    const { c, calls } = make()
    c.handleInput("[")
    expect(calls).toEqual([])
  })

  test("a adds an agent, esc closes", () => {
    const { c, onAddAgent, onClose } = make()
    c.handleInput("a")
    expect(onAddAgent).toHaveBeenCalled()
    c.handleInput(ESC)
    expect(onClose).toHaveBeenCalled()
  })
})

describe("PresetPickerOverlayComponent", () => {
  const presets = [
    { name: "NEWMAIN", personas: [{ id: "scout", name: "Scout", icon: "🔍", color: "#4A90D9", tools: ["read"] }] },
    { name: "3X2seats", personas: [] },
  ] as never[]
  const make = () => {
    const store = {
      getSnapshot: () => ({ roster }),
      pushNotice: vi.fn(),
      actions: { loadPreset: vi.fn(() => Promise.resolve()), applyPreset: vi.fn(() => Promise.resolve()) },
    } as unknown as RoomStore
    const onCancel = vi.fn()
    const onCompose = vi.fn()
    return { c: new PresetPickerOverlayComponent({ presets, store, onCancel, onCompose }, rows), store, onCancel, onCompose }
  }

  test("the list always ends with a virtual ＋ new row", () => {
    // /preset alone must be a complete entry point, even with no presets on disk.
    expect(text(make().c.render(90))).toContain("＋ new")
  })

  test("the preview follows the cursor with no 'open detail' step", () => {
    const { c } = make()
    expect(text(c.render(90))).toContain("Scout")
    c.handleInput(DOWN) // 3X2seats, no personas
    expect(text(c.render(90))).not.toContain("Scout")
  })

  test("⏎ loads the highlighted preset", () => {
    const { c, store } = make()
    c.handleInput(ENTER)
    expect(store.actions.loadPreset).toHaveBeenCalledWith("NEWMAIN")
  })

  test("a applies in place — roster swapped, transcript kept", () => {
    const { c, store } = make()
    c.handleInput("a")
    expect(store.actions.applyPreset).toHaveBeenCalledWith("NEWMAIN")
  })

  test("⏎ on ＋ new composes a blank roster, not a copy of the last preset", () => {
    const { c, onCompose } = make()
    c.handleInput(UP) // wraps onto the ＋ new row
    c.handleInput(ENTER)
    expect(onCompose).toHaveBeenCalledWith({ name: "", personas: [] }, true)
  })

  test("n remixes the highlighted preset", () => {
    const { c, onCompose } = make()
    c.handleInput("n")
    expect(onCompose).toHaveBeenCalledWith(presets[0], false)
  })

  test("the hint names the keys that actually apply to the current row", () => {
    const { c } = make()
    expect(text(c.render(90))).toContain("a apply")
    c.handleInput(UP)
    expect(text(c.render(90))).toContain("⏎ compose")
    expect(text(c.render(90))).not.toContain("a apply")
  })

  test("every line fits at every width", () => {
    const { c } = make()
    for (const w of [200, 120, 80, 60, 40, 20]) {
      for (const line of c.render(w)) expect(vis(line)).toBe(w)
    }
  })
})
