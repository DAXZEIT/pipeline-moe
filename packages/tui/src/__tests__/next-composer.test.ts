import { beforeAll, describe, expect, test } from "vitest"
import chalk from "chalk"
import type { Api, ModelInfo, PresetFile, PresetPersona, RoomStore } from "@pipeline-moe/client-core"
import { visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui"
import type { Overlay } from "../commands/types.js"
import { ComposerComponent, memberCard } from "../next/composer.js"

// The team composer. Two pieces: a roster list and a member card built on the
// form engine. The interesting assertions are about the SEAMS — that the card
// gets pushed rather than swapped in, that it commits back into the roster it
// came from, and that nothing reaches the disk until `s`.

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
const UP = "\x1b[A"
const DOWN = "\x1b[B"
const RIGHT = "\x1b[C"
const BACKSPACE = "\x7f"
const SPACE = " "

const type = (c: { handleInput: (d: string) => void }, s: string): void => {
  for (const ch of s) c.handleInput(ch)
}

const MODELS: ModelInfo[] = [
  { ref: "local/GRM 2.6", name: "GRM 2.6", provider: "local", local: true } as ModelInfo,
  { ref: "cerebras/qwen", name: "Qwen", provider: "cerebras", local: false } as ModelInfo,
]

function persona(over: Partial<PresetPersona> = {}): PresetPersona {
  return {
    id: "scout",
    name: "Scout",
    icon: "🔍",
    color: "#6Fb3d2",
    tools: ["read"],
    active: true,
    ...over,
  } as PresetPersona
}

const TRIO: PresetFile = {
  name: "trio",
  personas: [persona(), persona({ id: "builder", name: "Builder", icon: "🔨" })],
} as PresetFile

function cardDeps() {
  const log = { pickers: [] as Overlay[], renders: 0, done: [] as PresetPersona[] }
  return {
    log,
    deps: {
      openPicker: (o: Overlay) => log.pickers.push(o),
      requestRender: () => (log.renders += 1),
      rows: () => 40,
      onDone: (p: PresetPersona) => log.done.push(p),
    },
  }
}

describe("memberCard", () => {
  test("Done commits the edited persona, slugging the id", () => {
    const d = cardDeps()
    const card = memberCard(persona(), [], MODELS, d.deps)
    type(card, " Prime")
    card.handleInput(ENTER) // → id
    for (let i = 0; i < 5; i++) card.handleInput(BACKSPACE)
    type(card, "Lead Scout")
    expect(text(card.render(80))).toContain("@lead-scout")
    // Straight out: esc commits, same as the Ink card.
    card.handleInput(ESC)
    expect(d.log.done).toHaveLength(1)
    expect(d.log.done[0]).toMatchObject({ id: "lead-scout", name: "Scout Prime" })
  })

  test("a duplicate id is refused and keeps you in the card", () => {
    const d = cardDeps()
    const card = memberCard(persona(), ["builder"], MODELS, d.deps)
    card.handleInput(ENTER)
    for (let i = 0; i < 5; i++) card.handleInput(BACKSPACE)
    type(card, "builder")
    card.handleInput(ESC)
    expect(d.log.done).toHaveLength(0)
    expect(text(card.render(80))).toContain('Id "builder" is already taken')
  })

  test("an emoji backspaces as one glyph, and an empty icon falls back to 🤖", () => {
    const d = cardDeps()
    const card = memberCard(persona({ icon: "🐺" }), [], MODELS, d.deps)
    card.handleInput(DOWN)
    card.handleInput(DOWN) // emoji row
    card.handleInput(BACKSPACE)
    expect(text(card.render(80))).not.toContain("\ud83d")
    card.handleInput(ESC)
    expect(d.log.done[0]!.icon).toBe("🤖")
  })

  test("the tools are grouped, and space toggles within a group", () => {
    const d = cardDeps()
    const card = memberCard(persona({ tools: [] }), [], MODELS, d.deps)
    const out = text(card.render(90))
    expect(out).toContain("core")
    expect(out).toContain("web")
    expect(out).toContain("orch")
    // Walk to the web group: name, id, emoji, color, core, web.
    for (let i = 0; i < 5; i++) card.handleInput(DOWN)
    card.handleInput(SPACE)
    card.handleInput(ESC)
    expect(d.log.done[0]!.tools).toEqual(["web_search"])
  })

  test("the model row cycles for a quick pick and PUSHES the catalogue on ⏎", () => {
    const d = cardDeps()
    const card = memberCard(persona(), [], MODELS, d.deps)
    // name, id, emoji, color, core, web, orch, model
    for (let i = 0; i < 7; i++) card.handleInput(DOWN)
    expect(text(card.render(80))).toContain("host default")
    card.handleInput(RIGHT)
    expect(text(card.render(80))).toContain("GRM 2.6")
    card.handleInput(ENTER)
    expect(d.log.pickers).toHaveLength(1)
    const picker = d.log.pickers[0]!
    if (picker.kind !== "select") throw new Error("expected a select overlay")
    expect(picker.items.map((i) => i.id)).toEqual(["__default", "local/GRM 2.6", "cerebras/qwen", "__custom"])
    picker.onSelect("cerebras/qwen")
    card.handleInput(ESC)
    expect(d.log.done[0]!.model).toBe("cerebras/qwen")
  })

  test("custom… turns the model row into a text field, and ⏎ turns it back", () => {
    const d = cardDeps()
    const card = memberCard(persona(), [], MODELS, d.deps)
    for (let i = 0; i < 7; i++) card.handleInput(DOWN)
    card.handleInput(ENTER)
    const picker = d.log.pickers[0]!
    if (picker.kind !== "select") throw new Error("expected a select overlay")
    picker.onSelect("__custom")
    expect(text(card.render(80))).toContain("provider/id")
    type(card, "ollama/mistral")
    card.handleInput(ENTER) // commits AND leaves custom mode
    expect(text(card.render(80))).not.toContain("provider/id")
    card.handleInput(ESC)
    expect(d.log.done[0]!.model).toBe("ollama/mistral")
  })

  test("skills round-trip through the joined string; empty means inherit", () => {
    const d = cardDeps()
    const card = memberCard(persona({ skills: ["review", "plan"] }), [], MODELS, d.deps)
    // name, id, emoji, color, 3 tool groups, model, seat, thinking, vision, skills
    for (let i = 0; i < 11; i++) card.handleInput(DOWN)
    expect(text(card.render(90))).toContain("review, plan")
    type(card, ", write")
    card.handleInput(ESC)
    expect(d.log.done[0]!.skills).toEqual(["review", "plan", "write"])
  })

  test("the flags row toggles active and parallel independently", () => {
    const d = cardDeps()
    const card = memberCard(persona(), [], MODELS, d.deps)
    // …through to the flags row (second from the end, before the action).
    for (let i = 0; i < 20; i++) card.handleInput(DOWN)
    card.handleInput(UP) // the action row is last, so step back onto flags
    card.handleInput(SPACE) // active → off
    card.handleInput(RIGHT)
    card.handleInput(SPACE) // parallel → on
    card.handleInput(ESC)
    expect(d.log.done[0]).toMatchObject({ active: false, parallel: true })
  })

  test("the legend says esc COMMITS, because in this card it does", () => {
    const card = memberCard(persona(), [], MODELS, cardDeps().deps)
    const out = text(card.render(90))
    expect(out).toContain("esc/Done back to roster")
    // The generic "esc cancel" would be a lie here — esc runs the same commit
    // path as Done, validation and all.
    expect(out).not.toContain("esc cancel")
  })

  test("a seat is lower-cased and an empty one means its own context", () => {
    const d = cardDeps()
    const card = memberCard(persona({ seat: "Maker" }), [], MODELS, d.deps)
    card.handleInput(ESC)
    expect(d.log.done[0]!.seat).toBe("maker")
  })

  test("every line fits the width", () => {
    const card = memberCard(persona({ systemPrompt: "x".repeat(400) }), [], MODELS, cardDeps().deps)
    for (const w of [200, 120, 80, 60, 40, 20, 10]) {
      for (const line of card.render(w)) expect(vis(line)).toBe(Math.max(4, w))
    }
  })

  test("a short screen still shows the Done row when it is focused", () => {
    const d = cardDeps()
    const card = memberCard(persona(), [], MODELS, { ...d.deps, rows: () => 14 })
    for (let i = 0; i < 25; i++) card.handleInput(DOWN)
    const out = text(card.render(80))
    expect(out).toContain("[ Done ]")
    expect(out).toContain("▲ more")
  })
})

/* ── The roster screen ──────────────────────────────────────────────────────── */

function composerFixture(initial: PresetFile = TRIO, isNew = false, rows = 40) {
  const log = {
    pickers: [] as Overlay[],
    cards: [] as (Component & Focusable)[],
    pops: 0,
    closes: 0,
    renders: 0,
    saved: [] as PresetFile[],
    notices: [] as string[],
  }
  const store = {
    pushNotice: (m: string) => log.notices.push(m),
  } as unknown as RoomStore
  const api = {
    models: () => Promise.resolve({ models: MODELS, allowCloud: true }),
    personaTemplates: () =>
      Promise.resolve([{ id: "critic", name: "Critic", icon: "🧐", color: "#C678DD", tools: ["read"] }]),
    savePresetDoc: (p: PresetFile) => {
      log.saved.push(p)
      return Promise.resolve({ preset: p, warnings: [] })
    },
  } as unknown as Api
  const composer = new ComposerComponent(
    {
      initial,
      isNew,
      api,
      store,
      deps: {
        openPicker: (o: Overlay) => log.pickers.push(o),
        onClose: () => (log.closes += 1),
        requestRender: () => (log.renders += 1),
        openCard: (card) => {
          log.cards.push(card)
          return () => (log.pops += 1)
        },
      },
    },
    () => rows,
  )
  return { composer, log }
}

describe("ComposerComponent", () => {
  test("lists the roster with its per-member summary and the team stats", () => {
    const { composer } = composerFixture()
    const out = text(composer.render(90))
    expect(out).toContain("Edit preset: trio")
    expect(out).toContain("scout")
    expect(out).toContain("builder")
    expect(out).toContain("host default")
    expect(out).toContain("1 tools")
  })

  test("⏎ pushes the member card, and Done commits back into the roster", async () => {
    const { composer, log } = composerFixture()
    await new Promise((r) => setTimeout(r, 0))
    composer.handleInput(ENTER)
    expect(log.cards).toHaveLength(1)
    // The roster is still there behind it — the card was pushed, not swapped.
    expect(text(composer.render(90))).toContain("builder")

    const card = log.cards[0]! as Component & Focusable & { handleInput: (d: string) => void }
    type(card, " II")
    card.handleInput(ESC) // commit
    expect(log.pops).toBe(1)
    expect(log.closes).toBe(0) // the COMPOSER did not close
    expect(text(composer.render(90))).toContain("scout")
    // And the edit landed: save it and read the document.
    composer.handleInput("s")
    await new Promise((r) => setTimeout(r, 0))
    expect(log.saved[0]!.personas[0]!.name).toBe("Scout II")
  })

  test("`a` offers the template picker, and picking one opens its card", async () => {
    const { composer, log } = composerFixture()
    await new Promise((r) => setTimeout(r, 0))
    composer.handleInput("a")
    expect(log.pickers).toHaveLength(1)
    const picker = log.pickers[0]!
    if (picker.kind !== "select") throw new Error("expected a select overlay")
    expect(picker.items.map((i) => i.label)).toEqual(["＋ blank member", "🧐 Critic"])
    picker.onSelect("critic")
    // The new member is in the roster AND its card is open for editing.
    expect(text(composer.render(90))).toContain("critic")
    expect(log.cards).toHaveLength(1)
  })

  test("with no templates, `a` adds a blank member directly", () => {
    const { composer, log } = composerFixture()
    // The templates fetch has not resolved yet.
    composer.handleInput("a")
    expect(log.pickers).toHaveLength(0)
    expect(log.cards).toHaveLength(1)
  })

  test("d duplicates, x deletes, K/J reorder", async () => {
    const { composer, log } = composerFixture()
    await new Promise((r) => setTimeout(r, 0))
    composer.handleInput("d")
    composer.handleInput("s")
    await new Promise((r) => setTimeout(r, 0))
    expect(log.saved[0]!.personas.map((p) => p.id)).toEqual(["scout", "scout-2", "builder"])

    // The cursor followed the duplicate, so x removes scout-2 and lands on
    // builder — which is already last, so K is the move that can do anything.
    composer.handleInput("x")
    composer.handleInput("K")
    composer.handleInput("s")
    await new Promise((r) => setTimeout(r, 0))
    expect(log.saved[1]!.personas.map((p) => p.id)).toEqual(["builder", "scout"])
  })

  test("↑↓ wraps around the roster", () => {
    const { composer } = composerFixture()
    composer.handleInput(UP) // from 0 → the last member
    expect(text(composer.render(90))).toMatch(/▶ 🔨 builder/)
    composer.handleInput(DOWN)
    expect(text(composer.render(90))).toMatch(/▶ 🔍 scout/)
  })

  test("r renames, and a preset name is narrowed to filename characters", () => {
    const { composer } = composerFixture()
    composer.handleInput("r")
    for (let i = 0; i < 4; i++) composer.handleInput(BACKSPACE)
    type(composer, "My Team/2024!")
    // A preset name becomes a path segment on the server; the slash and the space
    // never make it into the field.
    expect(text(composer.render(90))).toContain("MyTeam2024")
    expect(text(composer.render(90))).not.toContain("/")
    composer.handleInput(ENTER)
    expect(text(composer.render(90))).not.toContain("type the preset name")
  })

  test("a new preset opens straight into naming, and refuses to save unnamed", async () => {
    const { composer, log } = composerFixture({ name: "", personas: [] } as PresetFile, true)
    expect(text(composer.render(90))).toContain("New preset")
    expect(text(composer.render(90))).toContain("type the preset name")
    composer.handleInput(ENTER) // leave naming with an empty name
    composer.handleInput("s")
    await new Promise((r) => setTimeout(r, 0))
    expect(log.saved).toHaveLength(0)
    expect(text(composer.render(90))).toContain("Name the preset first.")
  })

  test("an empty roster refuses to save and says why", async () => {
    const { composer, log } = composerFixture({ name: "solo", personas: [] } as PresetFile)
    composer.handleInput("s")
    await new Promise((r) => setTimeout(r, 0))
    expect(log.saved).toHaveLength(0)
    expect(text(composer.render(90))).toContain("Add at least one member.")
    expect(text(composer.render(90))).toContain("press a to add a member")
  })

  test("esc asks once before discarding", () => {
    const { composer, log } = composerFixture()
    composer.handleInput(ESC)
    expect(log.closes).toBe(0)
    expect(text(composer.render(90))).toContain("esc again to discard")
    // Any other key takes the question back.
    composer.handleInput(DOWN)
    expect(text(composer.render(90))).not.toContain("esc again to discard")
    composer.handleInput(ESC)
    composer.handleInput(ESC)
    expect(log.closes).toBe(1)
  })

  test("esc from naming returns to the roster rather than discarding", () => {
    const { composer, log } = composerFixture()
    composer.handleInput("r")
    composer.handleInput(ESC)
    expect(log.closes).toBe(0)
    expect(text(composer.render(90))).not.toContain("type the preset name")
  })

  test("a save failure stays on screen instead of closing", async () => {
    let closes = 0
    const failing = new ComposerComponent(
      {
        initial: TRIO,
        isNew: false,
        api: {
          models: () => Promise.resolve({ models: [], allowCloud: false }),
          personaTemplates: () => Promise.resolve([]),
          savePresetDoc: () => Promise.reject(new Error("disk full")),
        } as unknown as Api,
        store: { pushNotice: () => {} } as unknown as RoomStore,
        deps: {
          openPicker: () => {},
          onClose: () => (closes += 1),
          requestRender: () => {},
          openCard: () => () => {},
        },
      },
      () => 40,
    )
    failing.handleInput("s")
    await new Promise((r) => setTimeout(r, 0))
    expect(closes).toBe(0)
    expect(text(failing.render(90))).toContain("disk full")
  })

  test("saving reports the member count and closes", async () => {
    const { composer, log } = composerFixture()
    composer.handleInput("s")
    await new Promise((r) => setTimeout(r, 0))
    expect(log.notices[0]).toContain('Preset "trio" saved (2 members).')
    expect(log.closes).toBe(1)
  })

  test("a long roster windows and keeps its counter", () => {
    const many = {
      name: "big",
      personas: Array.from({ length: 30 }, (_, i) => persona({ id: `a${i}`, name: `Agent ${i}` })),
    } as PresetFile
    const { composer } = composerFixture(many, false, 20)
    const out = composer.render(90)
    expect(text(out)).toContain("1/30")
    expect(text(out)).toContain("▼ more")
    expect(out.length).toBeLessThanOrEqual(Math.floor(20 * 0.8))
  })

  test("every line fits the width", () => {
    const { composer } = composerFixture()
    for (const w of [200, 120, 80, 60, 40, 20, 10]) {
      for (const line of composer.render(w)) expect(vis(line)).toBe(Math.max(4, w))
    }
  })
})
