// arxiv_search — arXiv academic paper search tool definition
// Free, no API key. Returns paper titles, authors, abstracts, categories,
// and PDF links from the arXiv Atom feed API.

import { Type } from "typebox"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { AgentToolResult } from "@earendil-works/pi-coding-agent"

// Minimal text content type.
interface TextContent {
  type: "text"
  text: string
}

const arxivSearchSchema = Type.Object({
  query: Type.String({
    description: "Search terms (title, abstract, author, etc.)",
  }),
  max_results: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 50,
      default: 5,
      description: "Maximum results to return (1-50, default 5)",
    })
  ),
  categories: Type.Optional(
    Type.Array(Type.String(), {
      default: [],
      description: "arXiv categories to filter (e.g., cs.AI, cs.LG, cs.CL)",
    })
  ),
  sort_by: Type.Optional(
    Type.Enum({ relevance: "relevance", lastUpdatedDate: "lastUpdatedDate" }, {
      default: "relevance",
      description: "Sort order: relevance or lastUpdatedDate",
    })
  ),
})

const ARXIV_API = "http://export.arxiv.org/api/query"
const TIMEOUT_MS = 15_000
const ABSTRACT_MAX = 300

// Extract text between XML tags (simple, no dependency needed).
function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i")
  const match = xml.match(re)
  return match ? match[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"') : null
}

// Extract all tags of a given name.
function extractAllTags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "gi")
  const results: string[] = []
  let m
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"'))
  }
  return results
}

// Extract text between <entry> tags.
function extractEntries(xml: string): string[] {
  const re = /<entry>([\s\S]*?)<\/entry>/gi
  const results: string[] = []
  let m
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1])
  }
  return results
}

async function searchArxiv(query: string, maxResults: number, categories: string[], sortBy: string): Promise<AgentToolResult<undefined>> {
  // Build search query with category filters.
  const searchTerms: string[] = []
  if (query) {
    searchTerms.push(query)
  }
  if (categories.length > 0) {
    const catQuery = categories.map((c) => `cat:${c}`).join(" OR ")
    searchTerms.push(`(${catQuery})`)
  }
  const searchQuery = searchTerms.join(" AND ")

  // Build URL.
  const params = new URLSearchParams({
    search_query: searchQuery,
    max_results: String(Math.min(maxResults, 50)),
    sort_by: sortBy,
    sort_order: "descending",
  })
  const url = `${ARXIV_API}?${params}`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })

    if (!response.ok) {
      throw new Error(`arXiv API returned ${response.status} ${response.statusText}`)
    }

    const xml = await response.text()
    const entries = extractEntries(xml)

    if (entries.length === 0) {
      return {
        content: [{ type: "text", text: `No results found for: "${query}"` }],
        details: undefined,
      }
    }

    // Parse each entry.
    const results = entries.map((entryXml, i) => {
      const title = extractTag(entryXml, "title") ?? "No title"
      const abstract = (extractTag(entryXml, "summary") ?? "").replace(/\n/g, " ").trim()
      const authors = extractAllTags(entryXml, "name")
      const categories = extractAllTags(entryXml, "term")
      const id = extractTag(entryXml, "id") ?? ""
      const published = extractTag(entryXml, "published") ?? ""

      // Extract PDF URL from <link> tags.
      let pdfUrl = ""
      const linkRe = /<link[^>]*title="pdf"[^>]*href="([^"]*)"/i
      const pdfMatch = entryXml.match(linkRe)
      if (pdfMatch) pdfUrl = pdfMatch[1]
      else {
        // Fallback: construct from arXiv ID.
        const idRe = /arxiv\.org\/abs\/(.+)$/
        const idMatch = id.match(idRe)
        if (idMatch) pdfUrl = `https://arxiv.org/pdf/${idMatch[1]}`
      }

      // Truncate abstract.
      const truncatedAbstract = abstract.length > ABSTRACT_MAX
        ? abstract.slice(0, ABSTRACT_MAX) + "..."
        : abstract

      return [
        `${i + 1}. ${title}`,
        `   Authors: ${authors.join(", ")}`,
        `   Published: ${published}`,
        `   Categories: ${categories.join(", ")}`,
        `   Abstract: ${truncatedAbstract}`,
        `   PDF: ${pdfUrl}`,
      ].join("\n")
    })

    const header = `arXiv search results for "${query}" (${results.length} papers found)`
    return {
      content: [{ type: "text", text: header + "\n\n" + results.join("\n\n") }],
      details: undefined,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{
        type: "text",
        text: `arxiv_search error: ${msg}. Ensure the arXiv API is reachable at ${ARXIV_API}.`,
      }],
      details: undefined,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function createArxivSearchToolDefinition(): ToolDefinition<typeof arxivSearchSchema, undefined> {
  return {
    name: "arxiv_search",
    label: "arXiv Search",
    description:
      "Search academic papers on arXiv (2.3M+ papers). " +
      "Free, no API key. Returns titles, authors, abstracts, categories, and PDF links. " +
      "Abstracts are truncated to ~300 chars.",
    parameters: arxivSearchSchema,
    execute: async (_toolCallId, params) => {
      const query = params.query
      const maxResults = params.max_results ?? 5
      const categories = params.categories ?? []
      const sortBy = params.sort_by ?? "relevance"
      return searchArxiv(query, maxResults, categories, sortBy)
    },
  }
}
