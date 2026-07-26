import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"
import chalk from "chalk"
import { resetCapabilitiesCache, setCapabilities, setCellDimensions } from "@earendil-works/pi-tui"
import { ImageStrip, fromDataUri } from "../next/images.js"

// Inline images — the feature the migration ADDS. Both paths matter: a terminal
// with a graphics protocol, and one without (where the transcript must keep its
// `📎 N images` line exactly as the Ink client shows it).

beforeAll(() => {
  chalk.level = 3
  setCellDimensions({ widthPx: 9, heightPx: 18 })
})

afterEach(() => {
  resetCapabilitiesCache()
  vi.unstubAllGlobals()
})

/** A real 2×2 PNG — `getImageDimensions` parses the IHDR, so the bytes have to
 *  be a PNG and not a placeholder. */
const PNG_2x2 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAACp8Z5+AAAADUlEQVR42mP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
const DATA_URI = `data:image/png;base64,${PNG_2x2}`

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe("fromDataUri", () => {
  test("splits mime from payload", () => {
    expect(fromDataUri(DATA_URI)).toEqual({ mime: "image/png", base64: PNG_2x2 })
  })

  test("refuses anything that is not an image data URI", () => {
    expect(() => fromDataUri("data:text/plain;base64,aGk=")).toThrow()
    expect(() => fromDataUri("media/abc.png")).toThrow()
  })
})

describe("ImageStrip without a graphics protocol", () => {
  test("draws nothing, so the caller keeps its 📎 line", async () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true })
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const strip = new ImageStrip({ apiBase: "http://x", requestRender: () => {} })
    expect(strip.lines(["media/a.png"], 80)).toBeNull()
    await flush()
    // …and it never even asked the server for bytes it could not draw.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(ImageStrip.supported()).toBe(false)
  })
})

describe("ImageStrip with kitty", () => {
  const kitty = (): void => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true })
  }

  test("a data URI needs no server round-trip", async () => {
    kitty()
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    let renders = 0
    const strip = new ImageStrip({ apiBase: "http://x", requestRender: () => renders++ })
    expect(strip.lines([DATA_URI], 80)).toBeNull() // still loading on the first frame
    await flush()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(renders).toBe(1) // the fetch landing asks for the frame it missed
    const rows = strip.lines([DATA_URI], 80)!
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toContain("\x1b_G") // the kitty graphics sequence
  })

  test("fetches media/<file> by BASENAME and encodes what comes back", async () => {
    kitty()
    const fetchSpy = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => "image/png" },
        arrayBuffer: () => Promise.resolve(Buffer.from(PNG_2x2, "base64").buffer),
      }),
    )
    vi.stubGlobal("fetch", fetchSpy)
    const strip = new ImageStrip({ apiBase: "http://srv:5300", requestRender: () => {} })
    strip.lines(["media/deadbeef12.png"], 80)
    await flush()
    expect(fetchSpy).toHaveBeenCalledWith("http://srv:5300/api/media/deadbeef12.png")
    expect(strip.lines(["media/deadbeef12.png"], 80)![0]).toContain("\x1b_G")
  })

  test("the bytes are fetched ONCE, however many frames ask for them", async () => {
    kitty()
    const fetchSpy = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => "image/png" },
        arrayBuffer: () => Promise.resolve(Buffer.from(PNG_2x2, "base64").buffer),
      }),
    )
    vi.stubGlobal("fetch", fetchSpy)
    const strip = new ImageStrip({ apiBase: "http://x", requestRender: () => {} })
    for (let i = 0; i < 5; i++) strip.lines(["media/a.png"], 80)
    await flush()
    for (let i = 0; i < 5; i++) strip.lines(["media/a.png"], 80)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test("the SAME string comes back every frame — identity is what makes the diff free", async () => {
    kitty()
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => "image/png" },
        arrayBuffer: () => Promise.resolve(Buffer.from(PNG_2x2, "base64").buffer),
      }),
    )
    const strip = new ImageStrip({ apiBase: "http://x", requestRender: () => {} })
    strip.lines(["media/a.png"], 80)
    await flush()
    const first = strip.lines(["media/a.png"], 80)!
    const second = strip.lines(["media/a.png"], 80)!
    expect(second[0]).toBe(first[0]) // reference equality, not just value
  })

  test("a missing attachment says so on one line instead of vanishing", async () => {
    kitty()
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: false, status: 404, headers: { get: () => null } }))
    const strip = new ImageStrip({ apiBase: "http://x", requestRender: () => {} })
    strip.lines(["media/gone.png"], 80)
    await flush()
    const rows = strip.lines(["media/gone.png"], 80)!
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain("gone.png")
    expect(rows[0]).toContain("not on the server")
  })

  test("a network failure is reported, not retried on every frame", async () => {
    kitty()
    const fetchSpy = vi.fn(() => Promise.reject(new Error("ECONNREFUSED")))
    vi.stubGlobal("fetch", fetchSpy)
    const strip = new ImageStrip({ apiBase: "http://x", requestRender: () => {} })
    strip.lines(["media/a.png"], 80)
    await flush()
    for (let i = 0; i < 5; i++) strip.lines(["media/a.png"], 80)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(strip.lines(["media/a.png"], 80)![0]).toContain("ECONNREFUSED")
  })

  test("several attachments on one message stack their rows", async () => {
    kitty()
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => "image/png" },
        arrayBuffer: () => Promise.resolve(Buffer.from(PNG_2x2, "base64").buffer),
      }),
    )
    const strip = new ImageStrip({ apiBase: "http://x", requestRender: () => {} })
    strip.lines(["media/a.png", "media/b.png"], 80)
    await flush()
    const rows = strip.lines(["media/a.png", "media/b.png"], 80)!
    const sequences = rows.filter((l) => l.includes("\x1b_G"))
    expect(sequences).toHaveLength(2)
  })
})
