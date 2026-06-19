import { describe, expect, test, vi, beforeEach, afterEach } from "vitest"
import { buildCustomTools, availableCustomTools } from "../custom-tools/index.js"
import { createWebSearchToolDefinition } from "../custom-tools/web-search.js"

// Mock fetch for web_search tests.
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

function mockSuccessResponse(results: Array<{ title: string; url: string; content?: string }> = []) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ results }),
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

describe("buildCustomTools", () => {
  test("returns empty array when no tools requested", () => {
    const tools = buildCustomTools([])
    expect(tools).toHaveLength(0)
  })

  test("returns web_search when requested", () => {
    const tools = buildCustomTools(["web_search"])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe("web_search")
  })

  test("ignores unknown tool names", () => {
    const tools = buildCustomTools(["web_search", "unknown_tool"])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe("web_search")
  })

  test("returns only tools in the allowlist", () => {
    const tools = buildCustomTools(["web_search"])
    expect(tools).toHaveLength(1)
  })
})

describe("availableCustomTools", () => {
  test("returns web_search in the list", () => {
    const tools = availableCustomTools()
    expect(tools).toContain("web_search")
  })

  test("returns at least one tool", () => {
    const tools = availableCustomTools()
    expect(tools.length).toBeGreaterThanOrEqual(1)
  })
})

describe("web_search tool", () => {
  let tool: ReturnType<typeof createWebSearchToolDefinition>

  beforeEach(() => {
    tool = createWebSearchToolDefinition()
  })

  test("has correct name and description", () => {
    expect(tool.name).toBe("web_search")
    expect(tool.label).toBe("Web Search")
    expect(tool.description).toContain("SearXNG")
  })

  test("returns formatted results on success", async () => {
    mockSuccessResponse([
      { title: "Result 1", url: "https://example.com/1", content: "First result snippet" },
      { title: "Result 2", url: "https://example.com/2", content: "Second result snippet" },
    ])

    const result = await tool.execute("tc1", { query: "test query", limit: 2 }, undefined, undefined, {} as any)
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe("text")
    expect((result.content[0] as { text: string }).text).toContain("Result 1")
    expect((result.content[0] as { text: string }).text).toContain("Result 2")
    expect((result.content[0] as { text: string }).text).toContain("https://example.com/1")
    expect((result.content[0] as { text: string }).text).toContain("https://example.com/2")
  })

  test("uses default limit of 5", async () => {
    mockSuccessResponse([])

    await tool.execute("tc1", { query: "test" }, undefined, undefined, {} as any)

    const callArgs = mockFetch.mock.calls[0][0]
    expect(callArgs).toContain("limit=5")
  })

  test("respects custom limit", async () => {
    mockSuccessResponse([])

    await tool.execute("tc1", { query: "test", limit: 10 }, undefined, undefined, {} as any)

    const callArgs = mockFetch.mock.calls[0][0]
    expect(callArgs).toContain("limit=10")
  })

  test("caps limit at 20", async () => {
    mockSuccessResponse([])

    await tool.execute("tc1", { query: "test", limit: 50 }, undefined, undefined, {} as any)

    const callArgs = mockFetch.mock.calls[0][0]
    expect(callArgs).toContain("limit=20")
  })

  test("includes categories in request", async () => {
    mockSuccessResponse([])

    await tool.execute("tc1", { query: "test", categories: ["science", "it"] }, undefined, undefined, {} as any)

    const callArgs = mockFetch.mock.calls[0][0]
    expect(callArgs).toContain("categories=science%2Cit")
  })

  test("returns error message on network failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("WireGuard is down"))

    const result = await tool.execute("tc1", { query: "test" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("web_search error")
    expect((result.content[0] as { text: string }).text).toContain("WireGuard is down")
  })

  test("returns error message on HTTP error", async () => {
    mockErrorResponse(500, "Internal Server Error")

    const result = await tool.execute("tc1", { query: "test" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("web_search error")
    expect((result.content[0] as { text: string }).text).toContain("500")
  })

  test("returns no results message when query returns empty", async () => {
    mockSuccessResponse([])

    const result = await tool.execute("tc1", { query: "test" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("No results found")
    expect((result.content[0] as { text: string }).text).toContain("test")
  })

  test("truncates long snippets", async () => {
    const longContent = "A".repeat(300)
    mockSuccessResponse([{ title: "Long", url: "https://example.com", content: longContent }])

    const result = await tool.execute("tc1", { query: "test" }, undefined, undefined, {} as any)
    const snippet = (result.content[0] as { text: string }).text.split("\n")[3] // The snippet line
    expect(snippet!.length).toBeLessThan(250) // Well under 300 chars
  })

  test("aborts on timeout", async () => {
    // Simulate an abort error (what happens when fetch times out).
    mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"))

    const result = await tool.execute("tc1", { query: "test" }, undefined, undefined, {} as any)
    expect((result.content[0] as { text: string }).text).toContain("web_search error")
    expect((result.content[0] as { text: string }).text).toContain("aborted")
  })

  test("does not include terminate flag", async () => {
    mockSuccessResponse([])

    const result = await tool.execute("tc1", { query: "test" }, undefined, undefined, {} as any)
    expect(result.terminate).toBeUndefined()
  })

  test("calls SearXNG at the correct URL", async () => {
    mockSuccessResponse([])

    await tool.execute("tc1", { query: "hello world" }, undefined, undefined, {} as any)

    const url = mockFetch.mock.calls[0][0]
    expect(url).toContain("https://searxng.example.org")
    expect(url).toContain("q=hello+world")
    expect(url).toContain("format=json")
  })
})
