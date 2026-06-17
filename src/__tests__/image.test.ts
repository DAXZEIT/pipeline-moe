import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, readFile, access, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

/**
 * Inline reproduction of the saveImage logic to test the regex destructuring.
 * This is the pattern that broke — [,, ext, b64] vs [, ext, b64].
 */
function parseImageUri(uri: string): { ext: string; b64: string } {
  const match = uri.match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+\/=]+)$/)
  if (!match) throw new Error(`unsupported image format: ${uri.slice(0, 30)}...`)
  const [, ext, b64] = match
  return { ext, b64 }
}

test("parseImageUri — regex destructuring yields correct groups", () => {
  // 1x1 red PNG (base64)
  const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADklEQVQI12P4z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=="
  const uri = `data:image/png;base64,${b64}`

  const { ext, b64: parsedB64 } = parseImageUri(uri)

  // ext must be the format, not the base64 data
  expect(ext).toBe("png")
  // b64 must be the data, not undefined
  expect(parsedB64).toBe(b64)
  expect(parsedB64).not.toBe(undefined)
})

test("parseImageUri — jpeg", () => {
  const { ext } = parseImageUri("data:image/jpeg;base64,abc123")
  expect(ext).toBe("jpeg")
})

test("parseImageUri — rejects unsupported format", () => {
  expect(() => parseImageUri("data:image/svg+xml;base64,abc")).toThrow()
})

test("parseImageUri — rejects malformed uri", () => {
  expect(() => parseImageUri("not-a-uri")).toThrow()
})

// --- Full saveImage integration test ---

describe("saveImage integration", () => {
  let tempDir: string
  let mediaDir: string

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pipeline-moe-img-"))
    mediaDir = join(tempDir, "media")
    await mkdir(mediaDir, { recursive: true })
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  /**
   * Full saveImage reproduction — parse, hash, write, verify.
   */
  async function saveImage(uri: string): Promise<string> {
    const { ext, b64 } = parseImageUri(uri)
    const hash = createHash("md5").update(b64).digest("hex").slice(0, 12)
    const fileName = `${hash}.${ext}`
    const filePath = join(mediaDir, fileName)
    await writeFile(filePath, Buffer.from(b64, "base64"))
    return `media/${fileName}`
  }

  test("saveImage — file is written and readable", async () => {
    const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADklEQVQI12P4z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=="
    const uri = `data:image/png;base64,${b64}`

    const relPath = await saveImage(uri)
    expect(relPath).toMatch(/^media\/[a-f0-9]{12}\.png$/)

    const fullPath = join(tempDir, relPath)
    await expect(access(fullPath)).resolves.toBeUndefined()

    const contents = await readFile(fullPath)
    expect(contents.toString("base64")).toBe(b64)
  })

  test("saveImage — Buffer.from(b64, 'base64') must not throw", async () => {
    // This is the exact failure mode: b64 was undefined, Buffer.from(undefined, "base64") throws
    const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADklEQVQI12P4z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=="
    const uri = `data:image/png;base64,${b64}`

    // Should not throw
    await expect(saveImage(uri)).resolves.toBeDefined()
  })
})
