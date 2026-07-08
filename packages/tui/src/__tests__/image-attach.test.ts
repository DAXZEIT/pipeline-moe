import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { expandHome, loadImageAttachment, MAX_IMAGE_BYTES } from "../image-attach"

describe("expandHome", () => {
  test("expands bare ~", () => {
    expect(expandHome("~")).not.toBe("~")
    expect(expandHome("~")).toMatch(/^\//)
  })

  test("expands ~/ prefix", () => {
    const out = expandHome("~/Pictures/foo.png")
    expect(out).not.toContain("~")
    expect(out.endsWith("Pictures/foo.png")).toBe(true)
  })

  test("leaves absolute paths untouched", () => {
    expect(expandHome("/tmp/foo.png")).toBe("/tmp/foo.png")
  })

  test("leaves relative paths untouched", () => {
    expect(expandHome("foo.png")).toBe("foo.png")
  })
})

describe("loadImageAttachment", () => {
  let dir: string
  // 1x1 red PNG, same fixture as src/__tests__/image.test.ts.
  const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADklEQVQI12P4z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=="

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pmoe-tui-image-"))
    await mkdir(join(dir, "sub.png"), { recursive: true })
    await writeFile(join(dir, "pic.png"), Buffer.from(pngB64, "base64"))
    await writeFile(join(dir, "pic.jpg"), Buffer.from(pngB64, "base64"))
    await writeFile(join(dir, "pic.txt"), "not an image")
    await writeFile(join(dir, "big.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("reads a png and returns a data: URI with the right mime", async () => {
    const r = await loadImageAttachment(join(dir, "pic.png"))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.dataUri.startsWith("data:image/png;base64,")).toBe(true)
      expect(r.dataUri).toContain(pngB64)
    }
  })

  test("jpg extension maps to image/jpeg mime (server only accepts 'jpeg')", async () => {
    const r = await loadImageAttachment(join(dir, "pic.jpg"))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.dataUri.startsWith("data:image/jpeg;base64,")).toBe(true)
  })

  test("rejects unsupported extension", async () => {
    const r = await loadImageAttachment(join(dir, "pic.txt"))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("Unsupported image type")
  })

  test("rejects missing file", async () => {
    const r = await loadImageAttachment(join(dir, "nope.png"))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("File not found")
  })

  test("rejects a directory (extension alone doesn't make it a valid image)", async () => {
    const r = await loadImageAttachment(join(dir, "sub.png"))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("Not a file")
  })

  test("rejects oversized file", async () => {
    const r = await loadImageAttachment(join(dir, "big.png"))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("too large")
  })

  test("rejects empty path", async () => {
    const r = await loadImageAttachment("")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("Usage:")
  })

  test("expands ~ in the given path", async () => {
    // Not asserting success (no file at ~/... in CI) — just that it doesn't
    // treat the literal "~" as part of the extension/lookup and instead
    // reports a clean "File not found" against the expanded path.
    const r = await loadImageAttachment("~/pmoe-nonexistent-test-file.png")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).not.toContain("~")
  })
})
