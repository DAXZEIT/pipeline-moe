import { describe, expect, test, vi, beforeEach, afterEach } from "vitest"
import { createWebReadToolDefinition } from "../custom-tools/web-read.js"

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

function mockJinaResponse(title: string, content: string, url: string) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      code: 200,
      status: 200,
      data: { title, content, url },
    }),
  })
}

function mockErrorResponse(status: number, statusText: string) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    statusText,
  })
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe("web_read tool", () => {
  let tool: ReturnType<typeof createWebReadToolDefinition>

  beforeEach(() => {
    tool = createWebReadToolDefinition()
  })

  test("has correct name and description", () => {
    expect(tool.name).toBe("web_read")
    expect(tool.label).toBe("Web Read")
    expect(tool.description).toContain("Jina Reader")
    expect(tool.description).toContain("8000 chars")
  })

  test("returns formatted markdown content", async () => {
    mockJinaResponse("Test Page", "Some content here", "https://example.com")

    const result = await tool.execute("tc1", { url: "https://example.com" }, undefined, undefined, {} as any)
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe("text")
    expect((result.content[0] as { text: string }).text).toContain("# Test Page")
    expect((result.content[0] as { text: string }).text).toContain("Source: https://example.com")
    expect((result.content[0] as { text: string }).text).toContain("Some content here")
  })

  test("truncates content over 8000 chars", async () => {
    const longContent = "A".repeat(9000)
    mockJinaResponse("Long Page", longContent, "https://example.com/long")

    const result = await tool.execute("tc1", { url: "https://example.com/long" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("[content truncated")
    expect((result.content[0] as { text: string }).text).toContain("9000 chars total")
  })

  test("does not truncate content under 8000 chars", async () => {
    mockJinaResponse("Short Page", "Just some content", "https://example.com/short")

    const result = await tool.execute("tc1", { url: "https://example.com/short" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).not.toContain("[content truncated")
  })

  test("includes title and source in output", async () => {
    mockJinaResponse("My Title", "Content", "https://example.com/article")

    const result = await tool.execute("tc1", { url: "https://example.com/article" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("# My Title")
    expect((result.content[0] as { text: string }).text).toContain("Source: https://example.com/article")
  })

  test("returns error on HTTP failure", async () => {
    mockErrorResponse(500, "Internal Server Error")

    const result = await tool.execute("tc1", { url: "https://example.com" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("web_read error")
    expect((result.content[0] as { text: string }).text).toContain("500")
  })

  test("returns error on network failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"))

    const result = await tool.execute("tc1", { url: "https://example.com" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("web_read error")
    expect((result.content[0] as { text: string }).text).toContain("Network error")
  })

  test("returns error when no data in response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: 200, status: 200 }),
    })

    const result = await tool.execute("tc1", { url: "https://example.com" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("web_read error")
    expect((result.content[0] as { text: string }).text).toContain("No content returned")
  })

  test("calls Jina Reader with correct URL", async () => {
    mockJinaResponse("Title", "Content", "https://example.com")

    await tool.execute("tc1", { url: "https://example.com" }, undefined, undefined, {} as any)

    const calledUrl = mockFetch.mock.calls[0][0]
    expect(calledUrl).toBe("https://r.jina.ai/https://example.com")
  })

  test("sends Accept header for JSON", async () => {
    mockJinaResponse("Title", "Content", "https://example.com")

    await tool.execute("tc1", { url: "https://example.com" }, undefined, undefined, {} as any)

    const headers = mockFetch.mock.calls[0][1]?.headers
    expect(headers).toHaveProperty("Accept", "application/json")
  })

  test("does not include terminate flag", async () => {
    mockJinaResponse("Title", "Content", "https://example.com")

    const result = await tool.execute("tc1", { url: "https://example.com" }, undefined, undefined, {} as any)
    expect(result.terminate).toBeUndefined()
  })
})
