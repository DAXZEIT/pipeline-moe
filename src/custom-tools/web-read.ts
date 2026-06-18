// web_read — Jina Reader tool definition
// Extracts clean markdown content from any URL via Jina Reader.
// Free, no API key, 100 req/min. The natural follow-up to web_search:
// search finds URLs, web_read extracts their content.

import { Type } from "typebox"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { AgentToolResult } from "@earendil-works/pi-coding-agent"

// Minimal text content type (mirrors pi-ai TextContent — not re-exported).
interface TextContent {
  type: "text"
  text: string
}

const JinaResponse = Type.Object({
  code: Type.Number(),
  status: Type.Number(),
  data: Type.Optional(Type.Object({
    title: Type.String(),
    content: Type.String(),
    url: Type.String(),
  })),
})

const webReadSchema = Type.Object({
  url: Type.String({
    description: "The URL to extract content from",
  }),
})

const JINA_URL = "https://r.jina.ai"
const TIMEOUT_MS = 15_000
const MAX_CONTENT_LENGTH = 8000

async function readUrl(url: string): Promise<AgentToolResult<undefined>> {
  const jinaUrl = `${JINA_URL}/${url}`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(jinaUrl, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    })

    if (!response.ok) {
      throw new Error(`Jina Reader returned ${response.status} ${response.statusText}`)
    }

    const body = await response.json()
    const data = (body as { data?: { title: string; content: string; url: string } }).data

    if (!data) {
      throw new Error("No content returned by Jina Reader")
    }

    // Truncate to avoid context explosion.
    const content = data.content.length > MAX_CONTENT_LENGTH
      ? data.content.slice(0, MAX_CONTENT_LENGTH) + "\n\n[content truncated — " + data.content.length + " chars total]"
      : data.content

    const lines = [
      `# ${data.title}`,
      `Source: ${data.url}`,
      "",
      content,
    ]

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: undefined,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{
        type: "text",
        text: `web_read error: ${msg}. Ensure the URL is accessible and Jina Reader is reachable at ${JINA_URL}.`,
      }],
      details: undefined,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function createWebReadToolDefinition(): ToolDefinition<typeof webReadSchema, undefined> {
  return {
    name: "web_read",
    label: "Web Read",
    description:
      "Extract clean markdown content from any web page via Jina Reader. " +
      "Free, no API key, 100 req/min. The natural follow-up to web_search: " +
      "search finds URLs, web_read extracts their content. " +
      "Content is truncated to ~8000 chars to avoid context explosion — " +
      "ask for a specific section if you need more detail.",
    parameters: webReadSchema,
    execute: async (_toolCallId, params) => {
      const url = params.url
      return readUrl(url)
    },
  }
}
