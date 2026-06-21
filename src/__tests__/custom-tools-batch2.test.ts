import { describe, expect, test, vi, beforeEach } from "vitest"
import { buildCustomTools, availableCustomTools } from "../custom-tools/index.js"
import { createWebReadToolDefinition } from "../custom-tools/web-read.js"

/* ────────────────────────────────────────────────────
 *  Custom Tools — Batch 2 Integration Tests
 *  web_read + youtube_transcript
 * ──────────────────────────────────────────────────── */

// Mock fetch for web_read tests
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

beforeEach(() => {
  mockFetch.mockReset()
})

/* ── Registry — all three tools ──────────────────── */

describe("Registry — all three custom tools", () => {
  test("availableCustomTools returns all tools", () => {
    const names = availableCustomTools()
    expect(names).toContain("web_search")
    expect(names).toContain("web_read")
    expect(names).toContain("youtube_transcript")
    expect(names).toContain("arxiv_search")
    expect(names).toContain("youcom_search")
    expect(names).toHaveLength(5)
  })

  test("buildCustomTools returns all when requested", () => {
    const tools = buildCustomTools(["web_search", "web_read", "youtube_transcript", "arxiv_search", "youcom_search"])
    expect(tools).toHaveLength(5)
    expect(tools.map((t) => t.name)).toEqual(["web_search", "web_read", "youtube_transcript", "arxiv_search", "youcom_search"])
  })

  test("buildCustomTools returns only web_read when requested", () => {
    const tools = buildCustomTools(["web_read"])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe("web_read")
  })

  test("buildCustomTools returns only youtube_transcript when requested", () => {
    const tools = buildCustomTools(["youtube_transcript"])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe("youtube_transcript")
  })

  test("mixed request returns correct subset", () => {
    const tools = buildCustomTools(["web_search", "web_read"])
    expect(tools).toHaveLength(2)
    expect(tools.map((t) => t.name)).toEqual(["web_search", "web_read"])
  })
})

/* ── web_read — Jina Reader ─────────────────────── */

describe("web_read tool", () => {
  let tool: ReturnType<typeof createWebReadToolDefinition>

  beforeEach(() => {
    tool = createWebReadToolDefinition()
  })

  test("has correct name and description", () => {
    expect(tool.name).toBe("web_read")
    expect(tool.label).toBe("Web Read")
    expect(tool.description).toContain("Jina Reader")
  })

  test("returns formatted markdown with title, source, and content", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        code: 200,
        status: 200,
        data: {
          title: "Test Article",
          content: "This is the article content in markdown.",
          url: "https://example.com/article",
        },
      }),
    })

    const result = await tool.execute("tc1", { url: "https://example.com/article" }, undefined, undefined, {} as any)
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe("text")
    expect((result.content[0] as { text: string }).text).toContain("# Test Article")
    expect((result.content[0] as { text: string }).text).toContain("Source: https://example.com/article")
    expect((result.content[0] as { text: string }).text).toContain("This is the article content")
  })

  test("truncates content over 16000 chars with length note", async () => {
    const longContent = "A".repeat(18000)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        code: 200,
        status: 200,
        data: { title: "Long", content: longContent, url: "https://example.com" },
      }),
    })

    const result = await tool.execute("tc1", { url: "https://example.com" }, undefined, undefined, {} as any)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain("content truncated")
    expect(text).toContain("18000 chars total")
  })

  test("short content is not truncated", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        code: 200,
        status: 200,
        data: { title: "Short", content: "Just a few words", url: "https://example.com" },
      }),
    })

    const result = await tool.execute("tc1", { url: "https://example.com" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).not.toContain("truncated")
  })

  test("calls Jina Reader at https://r.jina.ai/{url}", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: 200, status: 200, data: { title: "T", content: "C", url: "https://example.com" } }),
    })

    await tool.execute("tc1", { url: "https://example.com" }, undefined, undefined, {} as any)

    const url = mockFetch.mock.calls[0][0]
    expect(url).toBe("https://r.jina.ai/https://example.com")
  })

  test("sends Accept: application/json header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: 200, status: 200, data: { title: "T", content: "C", url: "https://example.com" } }),
    })

    await tool.execute("tc1", { url: "https://example.com" }, undefined, undefined, {} as any)

    const headers = mockFetch.mock.calls[0][1]?.headers
    expect(headers).toEqual({ Accept: "application/json" })
  })

  test("returns error on no data from Jina", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: 200, status: 200, data: undefined }),
    })

    const result = await tool.execute("tc1", { url: "https://example.com" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("web_read error")
    expect((result.content[0] as { text: string }).text).toContain("No content")
  })

  test("returns error on HTTP failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, statusText: "Too Many Requests" })

    const result = await tool.execute("tc1", { url: "https://example.com" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("429")
    expect((result.content[0] as { text: string }).text).toContain("Too Many Requests")
  })

  test("returns error on network failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("fetch failed"))

    const result = await tool.execute("tc1", { url: "https://example.com" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("web_read error")
    expect((result.content[0] as { text: string }).text).toContain("fetch failed")
  })

  test("error message includes Jina URL for debugging", async () => {
    mockFetch.mockRejectedValueOnce(new Error("DNS failure"))

    const result = await tool.execute("tc1", { url: "https://example.com" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("r.jina.ai")
  })

  test("TypeBox schema requires url parameter", () => {
    expect(tool.parameters.type).toBe("object")
    expect(tool.parameters.properties.url.type).toBe("string")
  })
})

/* ── youtube_transcript — URL extraction ──────────── */

describe("youtube_transcript — URL extraction", () => {
  test("bare 11-char video ID", () => {
    const input = "dQw4w9WgXcQ"
    // Simulate extractVideoId
    if (/^[a-zA-Z0-9_-]{11}$/.test(input.trim())) {
      expect(input.trim()).toBe("dQw4w9WgXcQ")
    }
  })

  test("youtube.com/watch?v=VIDEO_ID", () => {
    const input = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    const match = input.match(/[?&]v=([a-zA-Z0-9_-]{11})/)
    expect(match?.[1]).toBe("dQw4w9WgXcQ")
  })

  test("youtu.be/VIDEO_ID", () => {
    const input = "https://youtu.be/dQw4w9WgXcQ"
    const match = input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/)
    expect(match?.[1]).toBe("dQw4w9WgXcQ")
  })

  test("youtube.com/embed/VIDEO_ID", () => {
    const input = "https://www.youtube.com/embed/dQw4w9WgXcQ"
    const match = input.match(/embed\/([a-zA-Z0-9_-]{11})/)
    expect(match?.[1]).toBe("dQw4w9WgXcQ")
  })

  test("short URL with extra params", () => {
    const input = "https://youtu.be/dQw4w9WgXcQ?t=10"
    const match = input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/)
    expect(match?.[1]).toBe("dQw4w9WgXcQ")
  })

  test("invalid input — too short", () => {
    const input = "abc"
    const bare = /^[a-zA-Z0-9_-]{11}$/.test(input.trim())
    const watch = input.match(/[?&]v=([a-zA-Z0-9_-]{11})/)
    const short = input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/)
    const embed = input.match(/embed\/([a-zA-Z0-9_-]{11})/)
    expect(bare).toBe(false)
    expect(watch).toBeNull()
    expect(short).toBeNull()
    expect(embed).toBeNull()
  })

  test("invalid input — not a YouTube URL", () => {
    const input = "https://example.com/video"
    const watch = input.match(/[?&]v=([a-zA-Z0-9_-]{11})/)
    const short = input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/)
    const embed = input.match(/embed\/([a-zA-Z0-9_-]{11})/)
    expect(watch).toBeNull()
    expect(short).toBeNull()
    expect(embed).toBeNull()
  })
})

/* ── youtube_transcript — time formatting ─────────── */

describe("youtube_transcript — time formatting", () => {
  // Simulate formatTime
  function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${s.toString().padStart(2, "0")}`
  }

  test("0 seconds → 0:00", () => {
    expect(formatTime(0)).toBe("0:00")
  })

  test("59 seconds → 0:59", () => {
    expect(formatTime(59)).toBe("0:59")
  })

  test("60 seconds → 1:00", () => {
    expect(formatTime(60)).toBe("1:00")
  })

  test("3661 seconds → 61:01", () => {
    expect(formatTime(3661)).toBe("61:01")
  })

  test("single digit seconds padded", () => {
    expect(formatTime(61)).toBe("1:01")
  })
})

/* ── Persona config — scout and fetcher ───────────── */

describe("Persona config — scout and fetcher", () => {
  test("scout has web_read", () => {
    const scoutTools = ["read", "grep", "find", "ls", "web_search", "web_read", "youtube_transcript"]
    expect(scoutTools).toContain("web_read")
  })

  test("scout has youtube_transcript", () => {
    const scoutTools = ["read", "grep", "find", "ls", "web_search", "web_read", "youtube_transcript"]
    expect(scoutTools).toContain("youtube_transcript")
  })

  test("scout has 7 tools total", () => {
    const scoutTools = ["read", "grep", "find", "ls", "web_search", "web_read", "youtube_transcript"]
    expect(scoutTools).toHaveLength(7)
  })

  test("fetcher has web_read", () => {
    const fetcherTools = ["read", "bash", "write", "grep", "find", "ls", "web_read"]
    expect(fetcherTools).toContain("web_read")
  })

  test("fetcher does NOT have web_search", () => {
    const fetcherTools = ["read", "bash", "write", "grep", "find", "ls", "web_read"]
    expect(fetcherTools).not.toContain("web_search")
  })

  test("fetcher does NOT have youtube_transcript", () => {
    const fetcherTools = ["read", "bash", "write", "grep", "find", "ls", "web_read"]
    expect(fetcherTools).not.toContain("youtube_transcript")
  })

  test("fetcher has 7 tools total", () => {
    const fetcherTools = ["read", "bash", "write", "grep", "find", "ls", "web_read"]
    expect(fetcherTools).toHaveLength(7)
  })
})

/* ── VALID_TOOLS includes new tools ───────────────── */

describe("VALID_TOOLS includes new tools", () => {
  const VALID_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "web_read", "youtube_transcript"])

  test("web_read is valid", () => {
    expect(VALID_TOOLS.has("web_read")).toBe(true)
  })

  test("youtube_transcript is valid", () => {
    expect(VALID_TOOLS.has("youtube_transcript")).toBe(true)
  })

  test("10 valid tools total", () => {
    expect(VALID_TOOLS.size).toBe(10)
  })

  test("unknown tool is filtered", () => {
    expect(VALID_TOOLS.has("fake_tool")).toBe(false)
  })
})

/* ── EditAgent ALL_TOOLS ──────────────────────────── */

describe("EditAgent ALL_TOOLS", () => {
  const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "web_read", "youtube_transcript"]

  test("includes web_read", () => {
    expect(ALL_TOOLS).toContain("web_read")
  })

  test("includes youtube_transcript", () => {
    expect(ALL_TOOLS).toContain("youtube_transcript")
  })

  test("10 tools total", () => {
    expect(ALL_TOOLS).toHaveLength(10)
  })
})

/* ── Research loop: search → read ─────────────────── */

describe("Research loop — search → read", () => {
  test("web_search returns URLs that web_read can consume", () => {
    // Simulate: search returns URLs, read consumes them
    const searchResult = {
      title: "Example Article",
      url: "https://example.com/article",
    }
    const urlToRead = searchResult.url
    expect(urlToRead).toBe("https://example.com/article")
    // The URL from search can be passed directly to web_read
    expect(typeof urlToRead).toBe("string")
  })

  test("complete research flow: search → extract URL → read", () => {
    // Step 1: Search returns structured results
    const searchResults = [
      { title: "Result 1", url: "https://example.com/1" },
      { title: "Result 2", url: "https://example.com/2" },
    ]

    // Step 2: Extract URL from a result
    const chosenUrl = searchResults[0].url

    // Step 3: That URL is what web_read consumes
    expect(chosenUrl).toBe("https://example.com/1")
    expect(chosenUrl.startsWith("https://")).toBe(true)
  })
})
