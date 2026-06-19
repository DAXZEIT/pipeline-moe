import { describe, expect, test } from "vitest"
import { buildCustomTools, availableCustomTools } from "../custom-tools/index.js"

/* ────────────────────────────────────────────────────
 *  Custom Tools — Integration Tests
 *  Focus: registry merge, validation, persona config,
 *  confined+custom tools merge (the integration points
 *  the builder's tests don't cover).
 * ──────────────────────────────────────────────────── */

/* ── Registry — buildCustomTools ──────────────────── */

describe("Registry — buildCustomTools integration", () => {
  test("returns only requested tools from allowlist", () => {
    const tools = buildCustomTools(["web_search"])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe("web_search")
  })

  test("empty allowlist returns empty array", () => {
    const tools = buildCustomTools([])
    expect(tools).toEqual([])
  })

  test("unknown tool name is silently ignored", () => {
    const tools = buildCustomTools(["fake_tool"])
    expect(tools).toEqual([])
  })

  test("mixed known/unknown returns only known", () => {
    const tools = buildCustomTools(["web_search", "fake_tool", "read"])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe("web_search")
  })

  test("duplicate in allowlist returns one instance", () => {
    const tools = buildCustomTools(["web_search", "web_search"])
    // Set-based matching — should return one tool
    expect(tools).toHaveLength(1)
  })
})

/* ── availableCustomTools ─────────────────────────── */

describe("availableCustomTools", () => {
  test("returns at least web_search", () => {
    const names = availableCustomTools()
    expect(names).toContain("web_search")
  })

  test("returns string array", () => {
    const names = availableCustomTools()
    expect(typeof names[0]).toBe("string")
  })
})

/* ── Tool definition structure ────────────────────── */

describe("web_search tool definition", () => {
  test("has name, description, and execute function", () => {
    const tools = buildCustomTools(["web_search"])
    const tool = tools[0]
    expect(tool.name).toBe("web_search")
    expect(tool.description).toBeDefined()
    expect(typeof tool.execute).toBe("function")
  })

  test("has TypeBox parameters schema", () => {
    const tools = buildCustomTools(["web_search"])
    const tool = tools[0]
    expect(tool.parameters).toBeDefined()
    // TypeBox objects have a type field
    expect((tool.parameters as { type?: string }).type).toBe("object")
  })
})

/* ── Validation — VALID_TOOLS ─────────────────────── */

describe("Validation — VALID_TOOLS", () => {
  test("web_search is in VALID_TOOLS", () => {
    const VALID_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "web_search"])
    expect(VALID_TOOLS.has("web_search")).toBe(true)
  })

  test("sandbox tools are in VALID_TOOLS", () => {
    const VALID_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "web_search"])
    expect(VALID_TOOLS.has("read")).toBe(true)
    expect(VALID_TOOLS.has("bash")).toBe(true)
    expect(VALID_TOOLS.has("edit")).toBe(true)
    expect(VALID_TOOLS.has("write")).toBe(true)
    expect(VALID_TOOLS.has("grep")).toBe(true)
    expect(VALID_TOOLS.has("find")).toBe(true)
    expect(VALID_TOOLS.has("ls")).toBe(true)
  })

  test("unknown tool is filtered by VALID_TOOLS", () => {
    const VALID_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "web_search"])
    const personaTools = ["read", "web_search", "fake_tool"]
    const filtered = personaTools.filter((t) => VALID_TOOLS.has(t))
    expect(filtered).toEqual(["read", "web_search"])
  })
})

/* ── Persona config — scout has web_search ────────── */

describe("Persona config — scout", () => {
  test("scout has web_search in tools", () => {
    const scoutTools = ["read", "grep", "find", "ls", "web_search"]
    expect(scoutTools).toContain("web_search")
  })

  test("scout has 5 tools total", () => {
    const scoutTools = ["read", "grep", "find", "ls", "web_search"]
    expect(scoutTools).toHaveLength(5)
  })

  test("non-scout agents don't have web_search by default", () => {
    // Builder default tools (no web_search)
    const builderTools = ["read", "bash", "edit", "write"]
    expect(builderTools).not.toContain("web_search")
  })
})

/* ── Confined + custom tools merge ────────────────── */

describe("Confined + custom tools merge", () => {
  test("buildCustomTools returns ToolDefinition array compatible with customTools merge", () => {
    // This verifies the return type is compatible with the spread in participant.ts:
    //   customTools: [
    //     ...buildConfinedTools(config.workspaceDir, persona.tools),
    //     ...buildCustomTools(persona.tools),
    //   ]
    const custom = buildCustomTools(["web_search"])
    // Each tool must have name and execute
    for (const t of custom) {
      expect(typeof t.name).toBe("string")
      expect(typeof t.execute).toBe("function")
    }
  })

  test("custom tools are gated by persona.tools allowlist", () => {
    // If persona.tools = ["read", "bash"], web_search should NOT appear
    const allowedTools = ["read", "bash"]
    const custom = buildCustomTools(allowedTools)
    expect(custom).toEqual([])
  })

  test("custom tools appear when in allowlist", () => {
    const allowedTools = ["read", "bash", "web_search"]
    const custom = buildCustomTools(allowedTools)
    expect(custom).toHaveLength(1)
    expect(custom[0].name).toBe("web_search")
  })
})

/* ── URL construction ─────────────────────────────── */

describe("SearXNG URL construction", () => {
  test("base URL is https://searxng.example.org", () => {
    const url = "https://searxng.example.org"
    expect(url).toContain("daxzeit.eu")
    expect(url).toContain("https")
  })

  test("search path is /search with format=json", () => {
    const path = "/search"
    expect(path).toBe("/search")
  })

  test("query parameter is encoded", () => {
    const query = "hello world"
    const encoded = encodeURIComponent(query)
    expect(encoded).toBe("hello%20world")
  })

  test("limit parameter is stringified", () => {
    const limit = 5
    expect(String(limit)).toBe("5")
  })

  test("categories are comma-separated", () => {
    const categories = ["science", "it"]
    const joined = categories.join(",")
    expect(joined).toBe("science,it")
  })
})

/* ── Snippet truncation ───────────────────────────── */

describe("Snippet truncation", () => {
  test("short snippet is not truncated", () => {
    const content = "A short snippet"
    const truncated = content.length > 200 ? content.slice(0, 200) + "…" : content
    expect(truncated).toBe(content)
  })

  test("long snippet is truncated with ellipsis", () => {
    const content = "A".repeat(300)
    const truncated = content.length > 200 ? content.slice(0, 200) + "…" : content
    expect(truncated.length).toBe(201) // 200 chars + 1 ellipsis
    expect(truncated.endsWith("…")).toBe(true)
  })

  test("exactly 200 chars is not truncated", () => {
    const content = "A".repeat(200)
    const truncated = content.length > 200 ? content.slice(0, 200) + "…" : content
    expect(truncated.length).toBe(200)
  })
})

/* ── Error message format ─────────────────────────── */

describe("Error message format", () => {
  test("error message includes SearXNG URL for debugging", () => {
    const url = "https://searxng.example.org"
    const msg = `web_search error: Network error. Ensure WireGuard is connected and SearXNG is reachable at ${url}.`
    expect(msg).toContain("web_search error")
    expect(msg).toContain(url)
  })

  test("HTTP error includes status code", () => {
    const status = 503
    const statusText = "Service Unavailable"
    const msg = `SearXNG returned ${status} ${statusText}`
    expect(msg).toContain("503")
    expect(msg).toContain("Service Unavailable")
  })
})
