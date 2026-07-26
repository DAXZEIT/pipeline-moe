import { beforeAll, describe, expect, test } from "vitest"
import chalk from "chalk"
import { visibleWidth } from "@earendil-works/pi-tui"
import type { Api, ModelInfo, PresetFile, RoomStore } from "@pipeline-moe/client-core"
import type { Overlay } from "../commands/types.js"
import { agentForm, editAgentForm, roomForm } from "../next/forms.js"

// The three wizards. Each is a `FormComponent` built from a declaration, so the
// tests drive real keystrokes and assert on the API call that comes out the other
// end — which is the whole contract these files carry now that the loop is shared.

beforeAll(() => {
  chalk.level = 3
})

const plain = (ls: string[]): string[] => ls.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
// WIDTH IS MEASURED THE WAY THE TERMINAL DOES IT, not with `string-width`.
// `▶` is East Asian Ambiguous: string-width says 2 columns, pi-tui and every
// terminal we run in say 1. Asserting with string-width means measuring the
// padding with the same wrong ruler that produced it, which is exactly how a
// focused form row shipped one column short of its own border in Phase 3.
const vis = (s: string): number => visibleWidth(s)
const text = (ls: string[]): string => plain(ls).join("\n")

const ESC = "\x1b"
const ENTER = "\r"
const DOWN = "\x1b[B"
const LEFT = "\x1b[D"
const RIGHT = "\x1b[C"
const SPACE = " "

const type = (form: { handleInput: (d: string) => void }, s: string): void => {
  for (const c of s) form.handleInput(c)
}

/** A deps bag that records the pickers a form raises and whether it closed. */
function deps(rows = 40) {
  const log = { pickers: [] as Overlay[], closes: 0, renders: 0 }
  return {
    log,
    deps: {
      openPicker: (o: Overlay) => log.pickers.push(o),
      onClose: () => (log.closes += 1),
      requestRender: () => (log.renders += 1),
      rows: () => rows,
    },
  }
}

function fakeStore(overrides: Record<string, unknown> = {}) {
  const notices: string[] = []
  const calls: { name: string; args: unknown[] }[] = []
  const rec =
    (name: string, result: unknown = {}) =>
    (...args: unknown[]) => {
      calls.push({ name, args })
      return Promise.resolve(result)
    }
  return {
    notices,
    calls,
    store: {
      pushNotice: (m: string) => notices.push(m),
      getSnapshot: () => ({ roster: [], tasks: [] }),
      actions: {
        createParticipant: rec("createParticipant"),
        updateParticipant: rec("updateParticipant"),
        getParticipant: rec("getParticipant", {
          name: "Scout",
          icon: "🔍",
          color: "#4A90D9",
          tools: ["read", "grep"],
        }),
        ...overrides,
      },
    } as unknown as RoomStore,
  }
}

const MODELS: ModelInfo[] = [
  { ref: "local/GRM 2.6", name: "GRM 2.6", provider: "local", local: true } as ModelInfo,
  { ref: "cerebras/qwen", name: "Qwen", provider: "cerebras", local: false } as ModelInfo,
]

const PRESETS: PresetFile[] = [
  {
    name: "trio",
    personas: [
      { id: "scout", name: "Scout", icon: "🔍", color: "#4A90D9", tools: ["read"], active: true } as never,
      { id: "builder", name: "Builder", icon: "🔨", color: "#EF9F27", tools: ["edit", "write"], active: true } as never,
    ],
  } as PresetFile,
]

function fakeApi(overrides: Partial<Api> = {}) {
  const calls: { name: string; args: unknown[] }[] = []
  return {
    calls,
    api: {
      presets: () => Promise.resolve(PRESETS),
      models: () => Promise.resolve({ models: MODELS, allowCloud: true }),
      personaTemplates: () => Promise.resolve([]),
      createRoom: (body: unknown) => {
        calls.push({ name: "createRoom", args: [body] })
        return Promise.resolve({ roomId: "r1", name: "Cloud Sprint" })
      },
      ...overrides,
    } as unknown as Api,
  }
}

describe("agentForm", () => {
  test("fills the fields and creates the participant", async () => {
    const { store, calls, notices } = fakeStore()
    const d = deps()
    const form = agentForm(store, d.deps)

    type(form, "Reviewer")
    form.handleInput(ENTER)
    type(form, "reads diffs")
    form.handleInput(ENTER) // → tools
    form.handleInput(ENTER) // → icon
    type(form, "🔎")
    form.handleInput(ENTER) // → Create
    form.handleInput(ENTER)
    await Promise.resolve()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe("createParticipant")
    expect(calls[0]!.args[0]).toEqual({
      name: "Reviewer",
      systemPrompt: "reads diffs",
      // The default grant, untouched.
      tools: ["read", "grep", "find", "ls"],
      icon: "🔎",
    })
    await Promise.resolve()
    expect(notices[0]).toContain('Agent "Reviewer" created.')
    expect(d.log.closes).toBe(1)
  })

  test("an empty icon is omitted rather than sent blank", async () => {
    const { store, calls } = fakeStore()
    const form = agentForm(store, deps().deps)
    type(form, "R")
    form.handleInput(DOWN)
    type(form, "p")
    form.handleInput(DOWN)
    form.handleInput(DOWN)
    form.handleInput(DOWN)
    form.handleInput(ENTER)
    await Promise.resolve()
    expect(calls[0]!.args[0]).not.toHaveProperty("icon")
  })

  test("submitting empty complains and does NOT call the server", () => {
    const { store, calls } = fakeStore()
    const d = deps()
    const form = agentForm(store, d.deps)
    for (let i = 0; i < 5; i++) form.handleInput(DOWN)
    form.handleInput(ENTER)
    expect(calls).toHaveLength(0)
    expect(text(form.render(70))).toContain("Name and system prompt are required.")
    expect(d.log.closes).toBe(0)
  })

  test("a rejected create surfaces the server's message in the form", async () => {
    const { store } = fakeStore({
      createParticipant: () => Promise.reject(new Error("persona id taken")),
    })
    const d = deps()
    const form = agentForm(store, d.deps)
    type(form, "R")
    form.handleInput(DOWN)
    type(form, "p")
    for (let i = 0; i < 4; i++) form.handleInput(DOWN)
    form.handleInput(ENTER)
    await new Promise((r) => setTimeout(r, 0))
    expect(text(form.render(70))).toContain("persona id taken")
    expect(d.log.closes).toBe(0)
  })

  test("space toggles a tool on the chips row", () => {
    const { store, calls } = fakeStore()
    const form = agentForm(store, deps().deps)
    type(form, "R")
    form.handleInput(DOWN)
    type(form, "p")
    form.handleInput(DOWN) // tools; the cursor starts on "read", which is granted
    form.handleInput(SPACE)
    form.handleInput(RIGHT)
    form.handleInput(SPACE) // grant "bash"
    for (let i = 0; i < 3; i++) form.handleInput(DOWN)
    form.handleInput(ENTER)
    expect((calls[0]!.args[0] as { tools: string[] }).tools).toEqual(["grep", "find", "ls", "bash"])
  })

  test("esc closes without creating anything", () => {
    const { store, calls } = fakeStore()
    const d = deps()
    const form = agentForm(store, d.deps)
    type(form, "R")
    form.handleInput(ESC)
    expect(calls).toHaveLength(0)
    expect(d.log.closes).toBe(1)
  })
})

describe("editAgentForm", () => {
  test("shows Loading… until the participant arrives, then pre-fills", async () => {
    const { store } = fakeStore()
    const form = editAgentForm("scout", store, deps().deps)
    expect(text(form.render(70))).toContain("Loading…")
    await new Promise((r) => setTimeout(r, 0))
    const out = text(form.render(70))
    expect(out).toContain("Scout")
    expect(out).toContain("🔍")
    expect(out).toContain("@scout")
  })

  test("the agent's current colour is slot 0, so leaving it alone is the default", async () => {
    const { store, calls } = fakeStore()
    const form = editAgentForm("scout", store, deps().deps)
    await new Promise((r) => setTimeout(r, 0))
    expect(text(form.render(70))).toContain("(current)")
    // Straight to Save without touching the colour.
    for (let i = 0; i < 5; i++) form.handleInput(DOWN)
    form.handleInput(ENTER)
    expect(calls.at(-1)!.name).toBe("updateParticipant")
    expect(calls.at(-1)!.args[1]).toMatchObject({ color: "#4A90D9", tools: ["read", "grep"] })
  })

  test("←→ walks the palette and the swatch follows", async () => {
    const { store, calls } = fakeStore()
    const form = editAgentForm("scout", store, deps().deps)
    await new Promise((r) => setTimeout(r, 0))
    form.handleInput(DOWN)
    form.handleInput(DOWN) // colour row
    form.handleInput(RIGHT)
    expect(text(form.render(70))).not.toContain("(current)")
    for (let i = 0; i < 3; i++) form.handleInput(DOWN)
    form.handleInput(ENTER)
    const patch = calls.at(-1)!.args[1] as { color: string }
    expect(patch.color).not.toBe("#4A90D9")
    // Cycling back returns to the original.
    expect(patch.color).toMatch(/^#/)
  })

  test("a blank name is refused and the server is not called", async () => {
    const { store, calls } = fakeStore()
    const form = editAgentForm("scout", store, deps().deps)
    await new Promise((r) => setTimeout(r, 0))
    for (let i = 0; i < 5; i++) form.handleInput("\x7f") // backspace over "Scout"
    for (let i = 0; i < 5; i++) form.handleInput(DOWN)
    form.handleInput(ENTER)
    expect(calls.filter((c) => c.name === "updateParticipant")).toHaveLength(0)
    expect(text(form.render(70))).toContain("Name is required.")
  })

  test("a failed load says so instead of showing an empty form", async () => {
    const { store } = fakeStore({ getParticipant: () => Promise.reject(new Error("404")) })
    const form = editAgentForm("ghost", store, deps().deps)
    await new Promise((r) => setTimeout(r, 0))
    expect(text(form.render(70))).toContain("Failed to load the agent.")
  })

  test("submitting before the load lands is a no-op, not a blank PATCH", () => {
    const { store, calls } = fakeStore()
    const form = editAgentForm("scout", store, deps().deps)
    for (let i = 0; i < 6; i++) form.handleInput(DOWN)
    form.handleInput(ENTER)
    expect(calls.filter((c) => c.name === "updateParticipant")).toHaveLength(0)
  })
})

describe("roomForm", () => {
  test("creates a room with the typed name and the cycled preset", async () => {
    const { api, calls } = fakeApi()
    const d = deps()
    let created: unknown[] = []
    const form = roomForm(api, { ...d.deps, onCreated: (...a) => (created = a) })
    await new Promise((r) => setTimeout(r, 0))

    type(form, "Cloud Sprint")
    form.handleInput(DOWN) // preset row
    form.handleInput(RIGHT) // → solo
    form.handleInput(RIGHT) // → trio
    expect(text(form.render(80))).toContain("trio")
    for (let i = 0; i < 4; i++) form.handleInput(DOWN)
    form.handleInput(ENTER)
    await new Promise((r) => setTimeout(r, 0))

    expect(calls).toHaveLength(1)
    expect(calls[0]!.args[0]).toEqual({ name: "Cloud Sprint", preset: "trio" })
    expect(created).toEqual(["r1", "Cloud Sprint", false])
    expect(d.log.closes).toBe(1)
  })

  test("solo mode grows a Model row and sends solo: true", async () => {
    const { api, calls } = fakeApi()
    const d = deps()
    const form = roomForm(api, { ...d.deps, onCreated: () => {} })
    await new Promise((r) => setTimeout(r, 0))

    expect(text(form.render(80))).not.toContain("Model:")
    form.handleInput(DOWN)
    form.handleInput(RIGHT) // → solo
    const out = text(form.render(80))
    expect(out).toContain("Model:")
    expect(out).toContain("a bare pi")
    // Name is optional in solo — the server derives solo/<model>.
    form.handleInput(DOWN) // model row
    form.handleInput(RIGHT) // pin the first model
    for (let i = 0; i < 3; i++) form.handleInput(DOWN)
    form.handleInput(ENTER)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls[0]!.args[0]).toEqual({ name: "", solo: true, model: "local/GRM 2.6" })
  })

  test("a name is required unless the room is solo", async () => {
    const { api, calls } = fakeApi()
    const form = roomForm(api, { ...deps().deps, onCreated: () => {} })
    await new Promise((r) => setTimeout(r, 0))
    for (let i = 0; i < 5; i++) form.handleInput(DOWN)
    form.handleInput(ENTER)
    expect(calls).toHaveLength(0)
    expect(text(form.render(80))).toContain("Name is required.")
  })

  test("a goal is reported so the client can say the room auto-started", async () => {
    const { api, calls } = fakeApi()
    let hadGoal: boolean | undefined
    const form = roomForm(api, { ...deps().deps, onCreated: (_id, _n, g) => (hadGoal = g) })
    await new Promise((r) => setTimeout(r, 0))
    type(form, "Sprint")
    // Name → Preset → Workdir. With the default roster there is no preview row
    // and no Model row, so the workdir is two down, not three.
    form.handleInput(DOWN)
    form.handleInput(DOWN)
    type(form, "/tmp/ws")
    form.handleInput(DOWN)
    type(form, "ship it")
    form.handleInput(DOWN)
    form.handleInput(ENTER)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls[0]!.args[0]).toMatchObject({ workspaceDir: "/tmp/ws", goal: "ship it" })
    expect(hadGoal).toBe(true)
  })

  test("⏎ on the Preset row PUSHES a picker instead of replacing the form", async () => {
    const { api } = fakeApi()
    const d = deps()
    const form = roomForm(api, { ...d.deps, onCreated: () => {} })
    await new Promise((r) => setTimeout(r, 0))
    type(form, "Keep me")
    form.handleInput(DOWN)
    form.handleInput(ENTER)

    expect(d.log.pickers).toHaveLength(1)
    const picker = d.log.pickers[0]!
    expect(picker.kind).toBe("select")
    // The form is still alive behind it, name intact — this is the `picking`
    // hack's replacement, and the reason it can be deleted rather than ported.
    expect(text(form.render(80))).toContain("Keep me")
    expect(d.log.closes).toBe(0)

    if (picker.kind !== "select") throw new Error("expected a select overlay")
    expect(picker.items.map((i) => i.label.trim())).toEqual([
      "● — default roster —",
      "— solo: pure pi —",
      "trio",
    ])
    // Ids are indices into the cycle, so a preset named "1" cannot collide.
    picker.onSelect("2")
    expect(text(form.render(80))).toContain("trio")
  })

  test("the solo Model row's ⏎ pushes the model catalogue", async () => {
    const { api } = fakeApi()
    const d = deps()
    const form = roomForm(api, { ...d.deps, onCreated: () => {} })
    await new Promise((r) => setTimeout(r, 0))
    form.handleInput(DOWN)
    form.handleInput(RIGHT) // solo
    form.handleInput(DOWN) // Model
    form.handleInput(ENTER)
    const picker = d.log.pickers[0]!
    if (picker.kind !== "select") throw new Error("expected a select overlay")
    expect(picker.title).toContain("Model")
    expect(picker.items.map((i) => i.id)).toEqual(["", "local/GRM 2.6", "cerebras/qwen"])
    picker.onSelect("cerebras/qwen")
    expect(text(form.render(80))).toContain("Qwen")
  })

  test("a preset shows its agents as a live preview between the fields", async () => {
    const { api } = fakeApi()
    const form = roomForm(api, { ...deps().deps, onCreated: () => {} })
    await new Promise((r) => setTimeout(r, 0))
    form.handleInput(DOWN)
    form.handleInput(LEFT) // wrap round to the last slot: trio
    const out = text(form.render(90))
    expect(out).toContain("🔍 Scout")
    expect(out).toContain("🔨 Builder")
    // …and it disappears again when the roster goes back to the default.
    form.handleInput(RIGHT)
    expect(text(form.render(90))).not.toContain("🔨 Builder")
  })

  test("no presets on the server still leaves a usable form", async () => {
    const { api } = fakeApi({ presets: () => Promise.resolve([]) } as Partial<Api>)
    const form = roomForm(api, { ...deps().deps, onCreated: () => {} })
    await new Promise((r) => setTimeout(r, 0))
    form.handleInput(DOWN)
    expect(text(form.render(80))).toContain("(no saved presets)")
  })

  test("the button says Creating… while the request is in flight", async () => {
    let resolve: (v: never) => void = () => {}
    const { api } = fakeApi({
      createRoom: () => new Promise((r) => (resolve = r)),
    } as Partial<Api>)
    const form = roomForm(api, { ...deps().deps, onCreated: () => {} })
    await new Promise((r) => setTimeout(r, 0))
    type(form, "Sprint")
    for (let i = 0; i < 4; i++) form.handleInput(DOWN)
    form.handleInput(ENTER)
    expect(text(form.render(80))).toContain("Creating…")
    // A second ⏎ must not fire a second createRoom.
    form.handleInput(ENTER)
    resolve({ roomId: "r1", name: "Sprint" } as never)
  })

  test("every line fits the width, at every width", async () => {
    const { api } = fakeApi()
    const form = roomForm(api, { ...deps().deps, onCreated: () => {} })
    await new Promise((r) => setTimeout(r, 0))
    form.handleInput(DOWN)
    form.handleInput(LEFT) // the widest state: a preset preview open
    for (const w of [200, 120, 80, 60, 40, 20, 10]) {
      for (const line of form.render(w)) expect(vis(line)).toBe(Math.max(4, w))
    }
  })
})
