import { afterEach, describe, expect, test } from "vitest"
import {
  __setExecForTest,
  MAX_CLIPBOARD_IMAGE_BYTES,
  readClipboardImage,
  readClipboardText,
} from "../clipboard-image"

// 1x1 red PNG — same fixture used across the other image tests in this repo.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADklEQVQI12P4z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=="

type Call = { file: string; args: string[] }

afterEach(() => __setExecForTest(null))

describe("readClipboardImage", () => {
  test("returns unavailable when neither wl-paste nor xclip exist", async () => {
    __setExecForTest(async () => {
      throw Object.assign(new Error("command not found"), { code: "ENOENT" })
    })
    const r = await readClipboardImage()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe("unavailable")
      expect(r.error).toContain("clipboard tool")
    }
  })

  test("returns no-image when the clipboard has content but nothing image-typed", async () => {
    __setExecForTest(async (file, args) => {
      if (file === "wl-paste" && args[0] === "--list-types") {
        return { stdout: "text/plain\ntext/plain;charset=utf-8\n" }
      }
      throw new Error("unexpected call")
    })
    const r = await readClipboardImage()
    expect(r).toEqual({ ok: false, reason: "no-image" })
  })

  test("finds an image mime, reads it, and returns a data: URI", async () => {
    const calls: Call[] = []
    __setExecForTest(async (file, args) => {
      calls.push({ file, args })
      if (file === "wl-paste" && args[0] === "--list-types") {
        return { stdout: "image/png\ntext/plain\n" }
      }
      if (file === "wl-paste" && args[0] === "--type" && args[1] === "image/png") {
        return { stdout: Buffer.from(PNG_B64, "base64") }
      }
      throw new Error("unexpected call: " + JSON.stringify({ file, args }))
    })
    const r = await readClipboardImage()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.dataUri).toBe(`data:image/png;base64,${PNG_B64}`)
    }
    expect(calls[0]).toEqual({ file: "wl-paste", args: ["--list-types"] })
    expect(calls[1]).toEqual({ file: "wl-paste", args: ["--type", "image/png"] })
  })

  test("prefers png when the clipboard offers multiple image representations", async () => {
    __setExecForTest(async (_file, args) => {
      if (args[0] === "--list-types") return { stdout: "image/jpeg\nimage/png\n" }
      if (args[0] === "--type") return { stdout: Buffer.from(args[1] === "image/png" ? "PNG" : "JPEG") }
      throw new Error("unexpected")
    })
    const r = await readClipboardImage()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.dataUri.startsWith("data:image/png;base64,")).toBe(true)
  })

  test("falls back to xclip when wl-paste is unavailable", async () => {
    const calls: Call[] = []
    __setExecForTest(async (file, args) => {
      calls.push({ file, args })
      if (file === "wl-paste") throw Object.assign(new Error("not found"), { code: "ENOENT" })
      if (file === "xclip" && args.includes("TARGETS")) return { stdout: "image/png\n" }
      if (file === "xclip" && args.includes("image/png")) return { stdout: Buffer.from(PNG_B64, "base64") }
      throw new Error("unexpected: " + JSON.stringify({ file, args }))
    })
    const r = await readClipboardImage()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.dataUri).toBe(`data:image/png;base64,${PNG_B64}`)
    // Confirms the fallback actually happened, not a lucky first call.
    expect(calls.some((c) => c.file === "wl-paste")).toBe(true)
    expect(calls.some((c) => c.file === "xclip")).toBe(true)
  })

  test("returns too-large when the image exceeds the 10MB cap", async () => {
    const big = Buffer.alloc(MAX_CLIPBOARD_IMAGE_BYTES + 100)
    __setExecForTest(async (_file, args) => {
      if (args[0] === "--list-types") return { stdout: "image/png\n" }
      if (args[0] === "--type") return { stdout: big }
      throw new Error("unexpected")
    })
    const r = await readClipboardImage()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe("too-large")
      expect(r.error).toContain("too large")
    }
  })

  test("returns error when listing succeeds but reading the bytes fails", async () => {
    __setExecForTest(async (_file, args) => {
      if (args[0] === "--list-types") return { stdout: "image/png\n" }
      if (args[0] === "--type") throw new Error("clipboard changed mid-read")
      throw new Error("unexpected")
    })
    const r = await readClipboardImage()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe("error")
      expect(r.error).toContain("clipboard changed mid-read")
    }
  })

  test("empty image payload is treated as no-image, not a 0-byte attachment", async () => {
    __setExecForTest(async (_file, args) => {
      if (args[0] === "--list-types") return { stdout: "image/png\n" }
      if (args[0] === "--type") return { stdout: Buffer.alloc(0) }
      throw new Error("unexpected")
    })
    const r = await readClipboardImage()
    expect(r).toEqual({ ok: false, reason: "no-image" })
  })
})

describe("readClipboardText", () => {
  test("reads via wl-paste --no-newline", async () => {
    const calls: Call[] = []
    __setExecForTest(async (file, args) => {
      calls.push({ file, args })
      return { stdout: "hello clipboard" }
    })
    const r = await readClipboardText()
    expect(r).toEqual({ ok: true, text: "hello clipboard" })
    expect(calls).toEqual([{ file: "wl-paste", args: ["--no-newline"] }])
  })

  test("falls back to xclip when wl-paste is unavailable", async () => {
    __setExecForTest(async (file) => {
      if (file === "wl-paste") throw Object.assign(new Error("not found"), { code: "ENOENT" })
      return { stdout: "from xclip" }
    })
    const r = await readClipboardText()
    expect(r).toEqual({ ok: true, text: "from xclip" })
  })

  test("returns ok:false when both tools fail", async () => {
    __setExecForTest(async () => {
      throw new Error("nope")
    })
    const r = await readClipboardText()
    expect(r).toEqual({ ok: false })
  })
})
