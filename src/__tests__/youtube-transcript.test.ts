import { describe, expect, test, vi, beforeEach } from "vitest"
import { createYoutubeTranscriptToolDefinition } from "../custom-tools/youtube-transcript.js"

// Mock youtube-transcript-plus.
vi.mock("youtube-transcript-plus", () => ({
  YoutubeTranscript: {
    fetchTranscript: vi.fn(),
  },
}))

const { YoutubeTranscript } = await import("youtube-transcript-plus")
const mockFetchTranscript = vi.mocked(YoutubeTranscript.fetchTranscript)

describe("youtube_transcript tool", () => {
  let tool: ReturnType<typeof createYoutubeTranscriptToolDefinition>

  beforeEach(() => {
    mockFetchTranscript.mockReset()
    tool = createYoutubeTranscriptToolDefinition()
  })

  test("has correct name and description", () => {
    expect(tool.name).toBe("youtube_transcript")
    expect(tool.label).toBe("YouTube Transcript")
    expect(tool.description).toContain("YouTube")
    expect(tool.description).toContain("8000 chars")
  })

  test("returns formatted transcript with timestamps", async () => {
    mockFetchTranscript.mockResolvedValueOnce([
      { text: "Hello world", offset: 0, duration: 3, lang: "en" },
      { text: "This is a test", offset: 3, duration: 4, lang: "en" },
      { text: "Goodbye", offset: 7, duration: 2, lang: "en" },
    ])

    const result = await tool.execute("tc1", { video: "dQw4w9WgXcQ" }, undefined, undefined, {} as any)
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe("text")
    expect((result.content[0] as { text: string }).text).toContain("[0:00] Hello world")
    expect((result.content[0] as { text: string }).text).toContain("[0:03] This is a test")
    expect((result.content[0] as { text: string }).text).toContain("[0:07] Goodbye")
  })

  test("handles bare 11-char video ID", async () => {
    mockFetchTranscript.mockResolvedValueOnce([
      { text: "Content", offset: 0, duration: 1, lang: "en" },
    ])

    const result = await tool.execute("tc1", { video: "dQw4w9WgXcQ" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("Content")
    expect(mockFetchTranscript).toHaveBeenCalledWith("dQw4w9WgXcQ")
  })

  test("extracts video ID from youtube.com/watch?v= URL", async () => {
    mockFetchTranscript.mockResolvedValueOnce([
      { text: "Content", offset: 0, duration: 1, lang: "en" },
    ])

    const result = await tool.execute("tc1", { video: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("Content")
    expect(mockFetchTranscript).toHaveBeenCalledWith("dQw4w9WgXcQ")
  })

  test("extracts video ID from youtu.be/ URL", async () => {
    mockFetchTranscript.mockResolvedValueOnce([
      { text: "Content", offset: 0, duration: 1, lang: "en" },
    ])

    const result = await tool.execute("tc1", { video: "https://youtu.be/dQw4w9WgXcQ" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("Content")
    expect(mockFetchTranscript).toHaveBeenCalledWith("dQw4w9WgXcQ")
  })

  test("extracts video ID from youtube.com/embed/ URL", async () => {
    mockFetchTranscript.mockResolvedValueOnce([
      { text: "Content", offset: 0, duration: 1, lang: "en" },
    ])

    const result = await tool.execute("tc1", { video: "https://www.youtube.com/embed/dQw4w9WgXcQ" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("Content")
    expect(mockFetchTranscript).toHaveBeenCalledWith("dQw4w9WgXcQ")
  })

  test("returns error for invalid video ID", async () => {
    const result = await tool.execute("tc1", { video: "not-a-valid-id" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("youtube_transcript error")
    expect((result.content[0] as { text: string }).text).toContain("Could not extract video ID")
  })

  test("returns error when no transcript available", async () => {
    mockFetchTranscript.mockResolvedValueOnce([])

    const result = await tool.execute("tc1", { video: "dQw4w9WgXcQ" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("No transcript available")
  })

  test("truncates transcript over 8000 chars", async () => {
    const longTranscript = Array.from({ length: 200 }, (_, i) => ({
      text: "A".repeat(50),
      offset: i * 5,
      duration: 5,
      lang: "en",
    }))
    mockFetchTranscript.mockResolvedValueOnce(longTranscript)

    const result = await tool.execute("tc1", { video: "dQw4w9WgXcQ" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("[transcript truncated")
  })

  test("does not truncate transcript under 8000 chars", async () => {
    mockFetchTranscript.mockResolvedValueOnce([
      { text: "Short transcript", offset: 0, duration: 1, lang: "en" },
    ])

    const result = await tool.execute("tc1", { video: "dQw4w9WgXcQ" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).not.toContain("[transcript truncated")
  })

  test("handles youtube-transcript-plus errors gracefully", async () => {
    mockFetchTranscript.mockRejectedValueOnce(new Error("Video unavailable"))

    const result = await tool.execute("tc1", { video: "dQw4w9WgXcQ" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("youtube_transcript error")
    expect((result.content[0] as { text: string }).text).toContain("Video unavailable")
  })

  test("formats timestamps as MM:SS", async () => {
    mockFetchTranscript.mockResolvedValueOnce([
      { text: "One minute", offset: 60, duration: 1, lang: "en" },
      { text: "Two minutes", offset: 120, duration: 1, lang: "en" },
    ])

    const result = await tool.execute("tc1", { video: "dQw4w9WgXcQ" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("[1:00] One minute")
    expect((result.content[0] as { text: string }).text).toContain("[2:00] Two minutes")
  })

  test("formats seconds with zero-padding", async () => {
    mockFetchTranscript.mockResolvedValueOnce([
      { text: "Five seconds", offset: 5, duration: 1, lang: "en" },
    ])

    const result = await tool.execute("tc1", { video: "dQw4w9WgXcQ" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("[0:05] Five seconds")
  })

  test("does not include terminate flag", async () => {
    mockFetchTranscript.mockResolvedValueOnce([
      { text: "Content", offset: 0, duration: 1, lang: "en" },
    ])

    const result = await tool.execute("tc1", { video: "dQw4w9WgXcQ" }, undefined, undefined, {} as any)
    expect(result.terminate).toBeUndefined()
  })
})
