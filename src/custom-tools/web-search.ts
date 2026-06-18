// web_search — SearXNG tool definition
// Wraps the local SearXNG instance at https://searxng.example.org/
// accessible via WireGuard. Returns formatted results as text content.

import { Type } from "typebox"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { AgentToolResult } from "@earendil-works/pi-coding-agent"

// Minimal text content type (mirrors pi-ai TextContent — not re-exported).
interface TextContent {
  type: "text"
  text: string
}

const SearxngResult = Type.Object({
  title: Type.String(),
  url: Type.String(),
  content: Type.Optional(Type.String()),
})

const SearxngResponse = Type.Object({
  results: Type.Array(SearxngResult),
  query: Type.Optional(Type.String()),
})

const webSearchSchema = Type.Object({
  query: Type.String({
    description: "The search query",
  }),
  limit: Type.Optional(
    Type.Number({
      default: 5,
      minimum: 1,
      maximum: 20,
      description: "Maximum number of results to return (1-20, default 5)",
    }),
  ),
  categories: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "SearXNG categories to search: general, it, science, news, images, videos, academic",
    }),
  ),
})

const SEARXNG_URL = "https://searxng.example.org"
const TIMEOUT_MS = 15_000

async function searchSearxng(
  query: string,
  limit: number,
  categories?: string[],
): Promise<AgentToolResult<undefined>> {
  const url = new URL("/search", SEARXNG_URL)
  url.searchParams.set("q", query)
  url.searchParams.set("format", "json")
  url.searchParams.set("limit", String(limit))
  if (categories && categories.length > 0) {
    url.searchParams.set("categories", categories.join(","))
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    })

    if (!response.ok) {
      throw new Error(`SearXNG returned ${response.status} ${response.statusText}`)
    }

    const body = await response.json()
    const results = (body as { results: Array<{ title: string; url: string; content?: string }> }).results ?? []

    if (results.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No results found for: "${query}"`,
        }],
        details: undefined,
      }
    }

    // Format results as structured text.
    const lines = [`Search results for "${query}" (${results.length} results):`]
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      lines.push(`\n${i + 1}. ${r.title}`)
      lines.push(`   URL: ${r.url}`)
      if (r.content) {
        // Truncate long snippets to avoid context bloat.
        const snippet = r.content.length > 200 ? r.content.slice(0, 200) + "…" : r.content
        lines.push(`   ${snippet}`)
      }
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: undefined,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{
        type: "text",
        text: `web_search error: ${msg}. Ensure WireGuard is connected and SearXNG is reachable at ${SEARXNG_URL}.`,
      }],
      details: undefined,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function createWebSearchToolDefinition(): ToolDefinition<typeof webSearchSchema, undefined> {
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web via SearXNG. Returns titles, URLs, and snippets for each result. " +
      "Use this to find current information, verify facts, or discover resources outside the workspace.",
    parameters: webSearchSchema,
    execute: async (_toolCallId, params) => {
      const query = params.query
      const limit = Math.min(params.limit ?? 5, 20)
      const categories = params.categories
      return searchSearxng(query, limit, categories)
    },
  }
}
