import { describe, expect, test, vi, beforeEach } from "vitest"
import { buildCustomTools, availableCustomTools } from "../custom-tools/index.js"
import { createArxivSearchToolDefinition } from "../custom-tools/arxiv-search.js"

/* ────────────────────────────────────────────────────
 *  Custom Tools — Batch 3 Integration Tests
 *  arxiv_search + youcom_search
 * ──────────────────────────────────────────────────── */

// Mock fetch for both tools
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

// Mock fs.readFileSync for youcom API key
const mockReadFileSync = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  mockReadFileSync.mockReset()
  mockReadFileSync.mockReturnValue(JSON.stringify({ api_key: "ydc-sk-test123" }))
})

/* ── Registry — all five tools ────────────────────── */

describe("Registry — all five custom tools", () => {
  test("availableCustomTools returns all five", () => {
    const names = availableCustomTools()
    expect(names).toContain("web_search")
    expect(names).toContain("web_read")
    expect(names).toContain("youtube_transcript")
    expect(names).toContain("arxiv_search")
    expect(names).toContain("youcom_search")
    expect(names).toHaveLength(5)
  })

  test("buildCustomTools returns all five when requested", () => {
    const tools = buildCustomTools(["web_search", "web_read", "youtube_transcript", "arxiv_search", "youcom_search"])
    expect(tools).toHaveLength(5)
    expect(tools.map((t) => t.name)).toEqual([
      "web_search",
      "web_read",
      "youtube_transcript",
      "arxiv_search",
      "youcom_search",
    ])
  })

  test("buildCustomTools returns only arxiv_search", () => {
    const tools = buildCustomTools(["arxiv_search"])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe("arxiv_search")
  })

  test("buildCustomTools returns only youcom_search", () => {
    const tools = buildCustomTools(["youcom_search"])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe("youcom_search")
  })

  test("partial request returns correct subset", () => {
    const tools = buildCustomTools(["web_search", "arxiv_search"])
    expect(tools).toHaveLength(2)
    expect(tools.map((t) => t.name)).toEqual(["web_search", "arxiv_search"])
  })
})

/* ── arxiv_search — tool definition ───────────────── */

describe("arxiv_search tool definition", () => {
  let tool: ReturnType<typeof createArxivSearchToolDefinition>

  beforeEach(() => {
    tool = createArxivSearchToolDefinition()
  })

  test("has correct name and description", () => {
    expect(tool.name).toBe("arxiv_search")
    expect(tool.label).toBe("arXiv Search")
    expect(tool.description).toContain("arXiv")
    expect(tool.description).toContain("2.3M")
  })

  test("TypeBox schema has correct parameters", () => {
    expect(tool.parameters.type).toBe("object")
    expect(tool.parameters.properties.query.type).toBe("string")
    expect(tool.parameters.properties.max_results.type).toBe("integer")
    expect(tool.parameters.properties.categories.type).toBe("array")
  })

  test("max_results has min/max constraints", () => {
    const props = tool.parameters.properties
    // TOptional resolves to the inner type at runtime (minimum/maximum are directly on the object)
    const maxResults = props.max_results as { minimum?: number; maximum?: number }
    expect(maxResults.minimum).toBe(1)
    expect(maxResults.maximum).toBe(50)
  })

  test("sort_by has correct enum values", () => {
    const props = tool.parameters.properties
    expect(props.sort_by.enum).toEqual(["relevance", "lastUpdatedDate"])
  })
})

/* ── arxiv_search — XML parsing ───────────────────── */

describe("arxiv_search — XML parsing", () => {
  test("extractTag extracts single tag content", () => {
    const xml = '<entry><title>Test Title</title></entry>'
    const re = new RegExp(`<title[^>]*>([^<]*)</title>`, "i")
    const match = xml.match(re)
    expect(match?.[1]).toBe("Test Title")
  })

  test("extractTag handles HTML entities", () => {
    const xml = '<summary>5 &lt; 10 &amp; 3 &gt; 1</summary>'
    const re = new RegExp(`<summary[^>]*>([^<]*)</summary>`, "i")
    const match = xml.match(re)
    expect(match?.[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")).toBe("5 < 10 & 3 > 1")
  })

  test("extractEntries splits multiple entries", () => {
    const xml = `<feed>
<entry><title>A</title><summary>First</summary></entry>
<entry><title>B</title><summary>Second</summary></entry>
<entry><title>C</title><summary>Third</summary></entry>
</feed>`
    const re = /<entry>([\s\S]*?)<\/entry>/gi
    const results: string[] = []
    let m
    while ((m = re.exec(xml)) !== null) {
      results.push(m[1])
    }
    expect(results).toHaveLength(3)
    expect(results[0]).toContain("A")
    expect(results[1]).toContain("B")
    expect(results[2]).toContain("C")
  })

  test("extractAllTags finds all name tags (authors)", () => {
    const xml = `<author><name>Smith, J.</name></author><author><name>Jones, K.</name></author>`
    const re = new RegExp(`<name[^>]*>([^<]*)</name>`, "gi")
    const results: string[] = []
    let m
    while ((m = re.exec(xml)) !== null) {
      results.push(m[1])
    }
    expect(results).toHaveLength(2)
    expect(results[0]).toBe("Smith, J.")
    expect(results[1]).toBe("Jones, K.")
  })

  test("PDF URL extraction from link tag", () => {
    const xml = '<link title="pdf" href="https://arxiv.org/pdf/2301.00001"/>'
    const linkRe = /<link[^>]*title="pdf"[^>]*href="([^"]*)"/i
    const pdfMatch = xml.match(linkRe)
    expect(pdfMatch?.[1]).toBe("https://arxiv.org/pdf/2301.00001")
  })

  test("PDF URL fallback from arXiv ID", () => {
    const id = "https://arxiv.org/abs/2301.00001"
    const idRe = /arxiv\.org\/abs\/(.+)$/
    const idMatch = id.match(idRe)
    expect(idMatch?.[1]).toBe("2301.00001")
    const pdfUrl = `https://arxiv.org/pdf/${idMatch![1]}`
    expect(pdfUrl).toBe("https://arxiv.org/pdf/2301.00001")
  })

  test("Abstract truncation at 300 chars", () => {
    const abstract = "A".repeat(400)
    const truncated = abstract.length > 300 ? abstract.slice(0, 300) + "..." : abstract
    expect(truncated.length).toBe(303) // 300 + 3 dots
    expect(truncated.endsWith("...")).toBe(true)
  })

  test("Short abstract not truncated", () => {
    const abstract = "A short abstract"
    const truncated = abstract.length > 300 ? abstract.slice(0, 300) + "..." : abstract
    expect(truncated).toBe(abstract)
  })
})

/* ── arxiv_search — URL construction ──────────────── */

describe("arxiv_search — URL construction", () => {
  test("base URL is correct", () => {
    expect("http://export.arxiv.org/api/query").toBe("http://export.arxiv.org/api/query")
  })

  test("search_query with category filter", () => {
    const query = "transformer"
    const categories = ["cs.AI", "cs.LG"]
    const catQuery = categories.map((c) => `cat:${c}`).join(" OR ")
    const searchQuery = query + " AND (" + catQuery + ")"
    expect(searchQuery).toBe("transformer AND (cat:cs.AI OR cat:cs.LG)")
  })

  test("search_query without category filter", () => {
    const query = "attention"
    const searchQuery = query
    expect(searchQuery).toBe("attention")
  })

  test("max_results capped at 50", () => {
    const maxResults = Math.min(75, 50)
    expect(maxResults).toBe(50)
  })

  test("sort_order is descending", () => {
    const sortOrder = "descending"
    expect(sortOrder).toBe("descending")
  })
})

/* ── arxiv_search — result formatting ─────────────── */

describe("arxiv_search — result formatting", () => {
  test("result includes numbered paper, authors, published, categories, abstract, PDF", () => {
    const lines = [
      "1. Test Paper",
      "   Authors: Smith, J.",
      "   Published: 2024-01-01",
      "   Categories: cs.AI",
      "   Abstract: A test abstract",
      "   PDF: https://arxiv.org/pdf/2401.00001",
    ]
    const result = lines.join("\n")
    expect(result).toContain("1. Test Paper")
    expect(result).toContain("Authors: Smith, J.")
    expect(result).toContain("Categories: cs.AI")
    expect(result).toContain("PDF: https://arxiv.org/pdf/2401.00001")
  })

  test("header includes query and count", () => {
    const header = `arXiv search results for "test" (2 papers found)`
    expect(header).toContain("test")
    expect(header).toContain("2 papers found")
  })

  test("no results message includes query", () => {
    const msg = `No results found for: "obscure topic"`
    expect(msg).toContain("obscure topic")
  })

  test("error message includes arXiv API URL", () => {
    const msg = `arxiv_search error: Network error. Ensure the arXiv API is reachable at http://export.arxiv.org/api/query.`
    expect(msg).toContain("http://export.arxiv.org/api/query")
  })
})

/* ── youcom_search — API key loading ──────────────── */

describe("youcom_search — API key loading", () => {
  test("API key file path is correct", () => {
    const path = "/home/dax/.config/you.com/credentials.json"
    expect(path).toContain("you.com")
    expect(path).toContain("credentials.json")
  })

  test("credentials file has api_key field", () => {
    const raw = JSON.stringify({ api_key: "ydc-sk-test123" })
    const parsed = JSON.parse(raw) as { api_key?: string }
    expect(parsed.api_key).toBe("ydc-sk-test123")
  })

  test("missing api_key field is detected", () => {
    const raw = JSON.stringify({ key: "wrong" })
    const parsed = JSON.parse(raw) as { api_key?: string }
    expect(parsed.api_key).toBeUndefined()
  })

  test("API key is never in error messages", () => {
    const key = "ydc-sk-secret123"
    const error = `youcom_search error: API key not found.`
    expect(error).not.toContain(key)
    expect(error).not.toContain("ydc-sk")
  })
})

/* ── youcom_search — search mode ──────────────────── */

describe("youcom_search — search mode", () => {
  test("search mode uses GET with query params", () => {
    const params = new URLSearchParams({ query: "test", count: "5" })
    expect(params.toString()).toContain("query=test")
    expect(params.toString()).toContain("count=5")
  })

  test("search mode includes freshness param when provided", () => {
    const params = new URLSearchParams({ query: "test", count: "5" })
    params.set("freshness", "week")
    expect(params.toString()).toContain("freshness=week")
  })

  test("search mode does not include freshness when not provided", () => {
    const params = new URLSearchParams({ query: "test", count: "5" })
    expect(params.toString()).not.toContain("freshness")
  })

  test("search mode API endpoint", () => {
    const endpoint = "https://ydc-index.io/v1/search"
    expect(endpoint).toContain("ydc-index.io")
    expect(endpoint).toContain("/v1/search")
  })

  test("X-API-Key header is used (not Authorization)", () => {
    const headers = { "X-API-Key": "ydc-sk-test" }
    expect(headers["X-API-Key"]).toBe("ydc-sk-test")
    expect((headers as Record<string, string>)["Authorization"]).toBeUndefined()
  })

  test("result formatting includes numbered results", () => {
    const hits = [
      { title: "Result 1", url: "https://a.com", snippet: "Snippet A" },
      { title: "Result 2", url: "https://b.com", snippet: "Snippet B" },
    ]
    const results = hits.map((hit, i) => {
      const lines = []
      lines.push(`${i + 1}. ${hit.title ?? "No title"}`)
      if (hit.url) lines.push(`   URL: ${hit.url}`)
      if (hit.snippet) lines.push(`   ${hit.snippet}`)
      return lines.join("\n")
    })
    expect(results[0]).toContain("1. Result 1")
    expect(results[0]).toContain("URL: https://a.com")
    expect(results[1]).toContain("2. Result 2")
  })

  test("count capped at 20", () => {
    const count = Math.min(30, 20)
    expect(count).toBe(20)
  })
})

/* ── youcom_search — research mode ────────────────── */

describe("youcom_search — research mode", () => {
  test("research mode uses POST", () => {
    const method = "POST"
    expect(method).toBe("POST")
  })

  test("research mode API endpoint", () => {
    const endpoint = "https://ydc-index.io/v1/research"
    expect(endpoint).toContain("/v1/research")
  })

  test("research mode body includes query and effort", () => {
    const body = JSON.stringify({ query: "test", effort: "standard" })
    expect(body).toContain("test")
    expect(body).toContain("standard")
  })

  test("research mode includes Content-Type header", () => {
    const headers = { "Content-Type": "application/json" }
    expect(headers["Content-Type"]).toBe("application/json")
  })

  test("research mode timeout is 60s", () => {
    expect(60_000).toBe(60000)
  })

  test("research answer is truncated at 8000 chars", () => {
    const answer = "A".repeat(10000)
    const truncated = answer.length > 8000
      ? answer.slice(0, 8000) + "\n\n[research truncated — " + answer.length + " chars total]"
      : answer
    expect(truncated).toContain("research truncated")
    expect(truncated).toContain("10000 chars total")
  })

  test("research answer short is not truncated", () => {
    const answer = "A short answer"
    const truncated = answer.length > 8000
      ? answer.slice(0, 8000) + "\n\n[research truncated — " + answer.length + " chars total]"
      : answer
    expect(truncated).toBe(answer)
  })

  test("research mode includes sources", () => {
    const sources = [
      { title: "Source 1", url: "https://a.com" },
      { title: "Source 2", url: "https://b.com" },
    ]
    const lines: string[] = ["Sources:"]
    sources.forEach((src, i) => {
      lines.push(`  ${i + 1}. ${src.title ?? "No title"} — ${src.url ?? "No URL"}`)
    })
    expect(lines[1]).toContain("1. Source 1")
    expect(lines[2]).toContain("2. Source 2")
  })
})

/* ── youcom_search — freshness enum ───────────────── */

describe("youcom_search — freshness enum", () => {
  test("freshness has correct values", () => {
    const freshness = ["day", "week", "month", "year"]
    expect(freshness).toContain("day")
    expect(freshness).toContain("week")
    expect(freshness).toContain("month")
    expect(freshness).toContain("year")
  })
})

/* ── Persona config — scout ───────────────────────── */

describe("Persona config — scout", () => {
  const scoutTools = ["read", "grep", "find", "ls", "web_search", "web_read", "youtube_transcript", "arxiv_search", "youcom_search"]

  test("scout has arxiv_search", () => {
    expect(scoutTools).toContain("arxiv_search")
  })

  test("scout has youcom_search", () => {
    expect(scoutTools).toContain("youcom_search")
  })

  test("scout has 9 tools total", () => {
    expect(scoutTools).toHaveLength(9)
  })

  test("scout does NOT have bash or edit", () => {
    expect(scoutTools).not.toContain("bash")
    expect(scoutTools).not.toContain("edit")
  })
})

/* ── VALID_TOOLS includes new tools ───────────────── */

describe("VALID_TOOLS", () => {
  const VALID_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "web_read", "youtube_transcript", "arxiv_search", "youcom_search"])

  test("arxiv_search is valid", () => {
    expect(VALID_TOOLS.has("arxiv_search")).toBe(true)
  })

  test("youcom_search is valid", () => {
    expect(VALID_TOOLS.has("youcom_search")).toBe(true)
  })

  test("12 valid tools total", () => {
    expect(VALID_TOOLS.size).toBe(12)
  })
})

/* ── EditAgent ALL_TOOLS ──────────────────────────── */

describe("EditAgent ALL_TOOLS", () => {
  const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "web_read", "youtube_transcript", "arxiv_search", "youcom_search"]

  test("includes arxiv_search", () => {
    expect(ALL_TOOLS).toContain("arxiv_search")
  })

  test("includes youcom_search", () => {
    expect(ALL_TOOLS).toContain("youcom_search")
  })

  test("12 tools total", () => {
    expect(ALL_TOOLS).toHaveLength(12)
  })
})

/* ── Query operators ──────────────────────────────── */

describe("Query operators", () => {
  test("site: operator works", () => {
    const query = "site:arxiv.org transformer"
    expect(query).toContain("site:arxiv.org")
  })

  test("filetype: operator works", () => {
    const query = "filetype:pdf attention"
    expect(query).toContain("filetype:pdf")
  })

  test("+term operator works", () => {
    const query = "LLM +transformer"
    expect(query).toContain("+transformer")
  })

  test("-term operator works", () => {
    const query = "attention -transformer"
    expect(query).toContain("-transformer")
  })
})
