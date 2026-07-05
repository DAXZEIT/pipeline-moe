// youcom_search — You.com enriched web search tool definition
// Two modes: "search" (fast snippets) and "research" (autonomous synthesis).
// API key from ~/.config/you.com/credentials.json — never exposed in results.

import { homedir } from "node:os"
import { join } from "node:path"
import { Type } from "typebox"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { AgentToolResult } from "@earendil-works/pi-coding-agent"

// Minimal text content type.
interface TextContent {
  type: "text"
  text: string
}

const youcomSearchSchema = Type.Object({
  query: Type.String({
    description: "Search query (supports operators: site:, filetype:, +term, -term)",
  }),
  mode: Type.Optional(
    Type.Enum({ search: "search", research: "research" }, {
      default: "search",
      description: "search = fast snippets, research = autonomous synthesis with citations",
    })
  ),
  count: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 20,
      default: 5,
      description: "Number of results for search mode (1-20, default 5)",
    })
  ),
  freshness: Type.Optional(
    Type.Enum({ day: "day", week: "week", month: "month", year: "year" }, {
      description: "Freshness filter for search mode",
    })
  ),
})

const YDC_API = "https://ydc-index.io"
const API_KEY_FILE = join(homedir(), ".config", "you.com", "credentials.json")
const TIMEOUT_SEARCH_MS = 15_000
const TIMEOUT_RESEARCH_MS = 60_000
const MAX_CONTENT_LENGTH = 8000

import { readFileSync } from "node:fs"

// Read API key from file — cached at module level after first read.
let apiKeyCache: { key: string | null; error: string | null } | null = null

function readApiKey(): { key: string | null; error: string | null } {
  if (apiKeyCache) return apiKeyCache

  try {
    const raw = readFileSync(API_KEY_FILE, "utf-8")
    const parsed = JSON.parse(raw) as { api_key?: string }
    if (!parsed.api_key) {
      apiKeyCache = { key: null, error: "No api_key field in credentials file" }
    } else {
      apiKeyCache = { key: parsed.api_key, error: null }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    apiKeyCache = { key: null, error: `Failed to read ${API_KEY_FILE}: ${msg}` }
  }

  return apiKeyCache
}

async function searchMode(query: string, count: number, freshness?: string): Promise<AgentToolResult<undefined>> {
  const { key, error } = readApiKey()
  if (error) {
    return {
      content: [{
        type: "text",
        text: `youcom_search error: ${error}. Check that ${API_KEY_FILE} exists and contains an api_key field.`,
      }],
      details: undefined,
    }
  }

  const params = new URLSearchParams({
    query,
    count: String(count),
  })
  if (freshness) params.set("freshness", freshness)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_SEARCH_MS)
  try {
    const response = await fetch(`${YDC_API}/v1/search?${params}`, {
      signal: controller.signal,
      headers: { "X-API-Key": key! },
    })

    if (!response.ok) {
      throw new Error(`You.com API returned ${response.status} ${response.statusText}`)
    }

    const body = await response.json() as { hits?: Array<{ title?: string; url?: string; snippet?: string }> }
    const hits = body.hits ?? []

    if (hits.length === 0) {
      return {
        content: [{ type: "text", text: `No results found for: "${query}"` }],
        details: undefined,
      }
    }

    const results = hits.map((hit, i) => {
      const lines: string[] = []
      lines.push(`${i + 1}. ${hit.title ?? "No title"}`)
      if (hit.url) lines.push(`   URL: ${hit.url}`)
      if (hit.snippet) lines.push(`   ${hit.snippet}`)
      return lines.join("\n")
    })

    const header = `You.com search results for "${query}" (${results.length} results)`
    return {
      content: [{ type: "text", text: header + "\n\n" + results.join("\n\n") }],
      details: undefined,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{
        type: "text",
        text: `youcom_search error: ${msg}. Ensure You.com API is reachable at ${YDC_API}.`,
      }],
      details: undefined,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function researchMode(query: string): Promise<AgentToolResult<undefined>> {
  const { key, error } = readApiKey()
  if (error) {
    return {
      content: [{
        type: "text",
        text: `youcom_search error: ${error}. Check that ${API_KEY_FILE} exists and contains an api_key field.`,
      }],
      details: undefined,
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_RESEARCH_MS)
  try {
    const response = await fetch(`${YDC_API}/v1/research`, {
      signal: controller.signal,
      method: "POST",
      headers: {
        "X-API-Key": key!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, effort: "standard" }),
    })

    if (!response.ok) {
      throw new Error(`You.com API returned ${response.status} ${response.statusText}`)
    }

    const body = await response.json() as { answer?: string; sources?: Array<{ title?: string; url?: string }> }
    const answer = body.answer ?? "No answer provided"
    const sources = body.sources ?? []

    const content = answer.length > MAX_CONTENT_LENGTH
      ? answer.slice(0, MAX_CONTENT_LENGTH) + "\n\n[research truncated — " + answer.length + " chars total]"
      : answer

    const lines: string[] = [
      `You.com research answer for "${query}"`,
      "",
      content,
    ]

    if (sources.length > 0) {
      lines.push("")
      lines.push("Sources:")
      sources.forEach((src, i) => {
        lines.push(`  ${i + 1}. ${src.title ?? "No title"} — ${src.url ?? "No URL"}`)
      })
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
        text: `youcom_search error: ${msg}. Ensure You.com API is reachable at ${YDC_API}.`,
      }],
      details: undefined,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function createYoucomSearchToolDefinition(): ToolDefinition<typeof youcomSearchSchema, undefined> {
  return {
    name: "youcom_search",
    label: "You.com Search",
    description:
      "Enriched web search via You.com API. " +
      "mode='search' for fast snippets with domain/freshness filtering. " +
      "mode='research' for autonomous synthesis with citations (standard effort, ~$0.05/query). " +
      "Supports query operators: site:, filetype:, +term, -term.",
    parameters: youcomSearchSchema,
    execute: async (_toolCallId, params) => {
      const query = params.query
      const mode = params.mode ?? "search"
      const count = params.count ?? 5
      const freshness = params.freshness

      if (mode === "research") {
        return researchMode(query)
      }
      return searchMode(query, count, freshness)
    },
  }
}
