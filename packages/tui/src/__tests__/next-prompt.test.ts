import { beforeAll, describe, expect, test, vi } from "vitest"
import chalk from "chalk"
import { visibleWidth } from "@earendil-works/pi-tui"
import type { PersonaDetail, RoomStore } from "@pipeline-moe/client-core"
import { editText } from "../external-editor.js"
import { PromptOverlayComponent } from "../next/prompt.js"

// The prompt pager, and the $EDITOR round-trip under it. `editText` is tested
// against a REAL editor — $EDITOR is just a command, so `sed -i` is a perfectly
// good one for a test and exercises the actual spawn rather than a mock of it.

beforeAll(() => {
  chalk.level = 3
})

const plain = (ls: string[]): string[] => ls.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
const vis = (s: string): number => visibleWidth(s)
const text = (ls: string[]): string => plain(ls).join("\n")
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const ESC = "\x1b"
const UP = "\x1b[A"
const DOWN = "\x1b[B"
const PGDN = "\x1b[6~"

describe("editText", () => {
  test("a real edit comes back trimmed", () => {
    vi.stubEnv("VISUAL", "")
    vi.stubEnv("EDITOR", "sed -i s/hello/goodbye/")
    expect(editText("hello world", { basename: "p.md" })).toEqual({ kind: "edited", text: "goodbye world" })
    vi.unstubAllEnvs()
  })

  test("an editor that writes nothing back reports unchanged, not an edit", () => {
    vi.stubEnv("VISUAL", "")
    vi.stubEnv("EDITOR", "true")
    expect(editText("keep me", { basename: "p.md" })).toEqual({ kind: "unchanged" })
    vi.unstubAllEnvs()
  })

  test("an emptied file is a mistake, never a save", () => {
    vi.stubEnv("VISUAL", "")
    vi.stubEnv("EDITOR", "truncate -s 0")
    expect(editText("delete everything", { basename: "p.md" })).toEqual({ kind: "empty" })
    vi.unstubAllEnvs()
  })

  test("the caller's suspend wraps the spawn — that is where the renderer steps aside", () => {
    vi.stubEnv("VISUAL", "")
    vi.stubEnv("EDITOR", "true")
    const order: string[] = []
    editText("x", {
      basename: "p.md",
      suspend: (run) => {
        order.push("stop")
        run()
        order.push("start")
      },
    })
    expect(order).toEqual(["stop", "start"])
    vi.unstubAllEnvs()
  })

  test("whitespace-only changes count as unchanged — comparison is trimmed", () => {
    vi.stubEnv("VISUAL", "")
    vi.stubEnv("EDITOR", "sh -c 'printf \"\\n\" >> \"$1\"' --")
    expect(editText("same", { basename: "p.md" })).toEqual({ kind: "unchanged" })
    vi.unstubAllEnvs()
  })
})

const LONG = Array.from({ length: 12 }, (_, i) => `paragraph ${i + 1} ` + "word ".repeat(40)).join("\n\n")

function makeStore(prompt: string, over: Partial<PersonaDetail> = {}) {
  const notices: string[] = []
  const updated: { systemPrompt?: string }[] = []
  const store = {
    pushNotice: (m: string) => notices.push(m),
    actions: {
      getParticipant: vi.fn(() =>
        Promise.resolve({
          id: "scout",
          name: "Scout",
          icon: "🔍",
          color: "#4A90D9",
          systemPrompt: prompt,
          ...over,
        } as PersonaDetail),
      ),
      updateParticipant: vi.fn((_id: string, patch: { systemPrompt?: string }) => {
        updated.push(patch)
        return Promise.resolve()
      }),
    },
  } as unknown as RoomStore
  return { store, notices, updated }
}

const make = (prompt: string, rows = 40) => {
  const { store, notices, updated } = makeStore(prompt)
  const onClose = vi.fn()
  const suspend = (run: () => void): void => run()
  const c = new PromptOverlayComponent(
    { agentId: "scout", store, onClose, suspend, requestRender: () => {} },
    () => rows,
  )
  return { c, store, notices, updated, onClose }
}

describe("PromptOverlayComponent", () => {
  test("says Loading… until the agent lands, then names it", async () => {
    const { c } = make("hello")
    expect(text(c.render(80))).toContain("Loading…")
    await flush()
    const out = text(c.render(80))
    expect(out).toContain("🔍 Scout")
    expect(out).toContain("hello")
    expect(out).not.toContain("Loading…")
  })

  test("long lines WRAP — the whole point of a pager is not hiding the end", async () => {
    const { c } = make("x ".repeat(200))
    await flush()
    const body = plain(c.render(80)).filter((l) => l.includes("x x"))
    expect(body.length).toBeGreaterThan(1)
    // …and nothing was thrown away: the wrap keeps every token.
    expect(body.join("").match(/x/g)!.length).toBeGreaterThan(150)
  })

  test("blank lines survive the wrap — a paragraph break is content", async () => {
    const { c } = make("first\n\nsecond")
    await flush()
    const body = plain(c.render(80))
    const first = body.findIndex((l) => l.includes("first"))
    const second = body.findIndex((l) => l.includes("second"))
    expect(second).toBe(first + 2)
  })

  test("↓ scrolls one line, ⇟ a page, and neither runs off the end", async () => {
    const { c } = make(LONG, 30)
    await flush()
    const top = text(c.render(80))
    expect(top).toContain("paragraph 1")
    c.handleInput(DOWN)
    expect(text(c.render(80))).not.toBe(top)
    for (let i = 0; i < 50; i++) c.handleInput(PGDN)
    const bottom = text(c.render(80))
    expect(bottom).toContain("▲ more")
    expect(bottom).not.toContain("▼ more")
    for (let i = 0; i < 50; i++) c.handleInput(UP)
    expect(text(c.render(80))).toContain("paragraph 1")
  })

  test("the counter reports the window over the WRAPPED line count", async () => {
    const { c } = make(LONG, 30)
    await flush()
    expect(text(c.render(80))).toMatch(/1-\d+\/\d+/)
  })

  test("esc closes", async () => {
    const { c, onClose } = make("hi")
    await flush()
    c.handleInput(ESC)
    expect(onClose).toHaveBeenCalled()
  })

  test("e saves what the editor wrote, notices it and closes", async () => {
    vi.stubEnv("VISUAL", "")
    vi.stubEnv("EDITOR", "sed -i s/before/after/")
    const { c, updated, notices, onClose } = make("before")
    await flush()
    c.handleInput("e")
    await flush()
    expect(updated).toEqual([{ systemPrompt: "after" }])
    expect(notices.join(" ")).toContain("@scout system prompt updated")
    expect(onClose).toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  test("e with no change notices it and keeps the pager open", async () => {
    vi.stubEnv("VISUAL", "")
    vi.stubEnv("EDITOR", "true")
    const { c, updated, notices, onClose } = make("untouched")
    await flush()
    c.handleInput("e")
    await flush()
    expect(updated).toEqual([])
    expect(notices.join(" ")).toContain("unchanged")
    expect(onClose).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  test("an emptied prompt is refused, in the box, without a request", async () => {
    vi.stubEnv("VISUAL", "")
    vi.stubEnv("EDITOR", "truncate -s 0")
    const { c, updated } = make("was here")
    await flush()
    c.handleInput("e")
    await flush()
    expect(updated).toEqual([])
    expect(text(c.render(80))).toContain("Empty prompt")
    vi.unstubAllEnvs()
  })

  test("e before the agent has loaded does nothing at all", () => {
    vi.stubEnv("VISUAL", "")
    vi.stubEnv("EDITOR", "sed -i s/a/b/")
    const { c, updated } = make("a")
    c.handleInput("e")
    expect(updated).toEqual([])
    vi.unstubAllEnvs()
  })

  test("every framed line is exactly the width", async () => {
    const { c } = make(LONG)
    await flush()
    for (const w of [40, 56, 80, 120]) {
      for (const line of c.render(w)) expect(vis(line)).toBe(w)
    }
  })

  test("a failed load says so instead of paging an empty prompt forever", async () => {
    const store = {
      pushNotice: () => {},
      actions: { getParticipant: () => Promise.reject(new Error("nope")) },
    } as unknown as RoomStore
    const c = new PromptOverlayComponent(
      { agentId: "ghost", store, onClose: () => {}, suspend: (r) => r(), requestRender: () => {} },
      () => 40,
    )
    await flush()
    expect(text(c.render(80))).toContain("Failed to load the agent.")
  })
})
