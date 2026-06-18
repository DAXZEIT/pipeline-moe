import { describe, it, expect } from "vitest"
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const MEMORY_DIR = join(__dirname, "..", "..", "agent_memory")

/**
 * Step 4 of PLAN-68db51a9 — verify memory injection.
 *
 * We can't test Participant.create() with a real LLM, so we test the
 * injection logic directly: file existence, size limits, formatting.
 */
describe("memory injection", () => {
  // ── File existence and size ──────────────────────────────────────────

  it("agent memory files exist for all active personas", () => {
    const expectedAgents = ["Auditor", "Builder", "Fetcher", "Planner", "Scribe", "Scout", "Tester"]
    for (const agent of expectedAgents) {
      const path = join(MEMORY_DIR, `${agent}.md`)
      expect(existsSync(path), `${agent}.md should exist`).toBe(true)
    }
  })

  it("each memory file is under 4KB (injection guard)", () => {
    const agents = ["Auditor", "Builder", "Fetcher", "Planner", "Scribe", "Scout", "Tester"]
    for (const agent of agents) {
      const path = join(MEMORY_DIR, `${agent}.md`)
      const content = readFileSync(path, "utf-8")
      expect(content.length, `${agent}.md should be under 4KB`).toBeLessThan(4096)
    }
  })

  it("README.md exists and documents the system", () => {
    const readmePath = join(MEMORY_DIR, "README.md")
    expect(existsSync(readmePath)).toBe(true)
    const content = readFileSync(readmePath, "utf-8")
    // README mentions the directory and the guard
    expect(content).toContain("4KB")
    expect(content).toContain("session")
    expect(content).toContain("compaction")
  })

  // ── Injection logic verification ─────────────────────────────────────

  /** Simulate the injection logic from Participant.create(). */
  function buildMemoryNote(personaId: string, memoryDir: string): string {
    const memoryPath = join(memoryDir, `${personaId}.md`)
    let memoryNote = ""
    if (existsSync(memoryPath)) {
      const raw = readFileSync(memoryPath, "utf-8")
      const content = raw.length > 4096 ? raw.slice(0, 4096) + "… (truncated)" : raw
      memoryNote = `\nYOUR MEMORY (agent_memory/${personaId}.md):\n${content}\n` +
        "---\n(End of memory — updated by the scribe. After compaction, this is refreshed.)\n"
    }
    return memoryNote
  }

  it("injection produces correct format for existing file", () => {
    const note = buildMemoryNote("Builder", MEMORY_DIR)
    expect(note).toContain("YOUR MEMORY (agent_memory/Builder.md):")
    expect(note).toContain("---")
    expect(note).toContain("End of memory — updated by the scribe")
    expect(note).toContain("After compaction, this is refreshed")
    // Should contain actual content from the file, not empty
    const fileContent = readFileSync(join(MEMORY_DIR, "Builder.md"), "utf-8")
    expect(note).toContain(fileContent.trim().split("\n")[0])
  })

  it("injection returns empty string for missing file", () => {
    const note = buildMemoryNote("NonExistentAgent", MEMORY_DIR)
    expect(note).toBe("")
  })

  it("injection truncates files over 4KB", () => {
    const tmpDir = join(__dirname, "..", "..", "tmp_test_memory")
    try {
      mkdirSync(tmpDir, { recursive: true })
      const bigFile = join(tmpDir, "BigAgent.md")
      const bigContent = "X".repeat(5000)
      writeFileSync(bigFile, bigContent)

      const note = buildMemoryNote("BigAgent", tmpDir)
      expect(note).toContain("… (truncated)")
      // The note should NOT contain the full 5000 chars
      expect(note.length).toBeLessThan(5000)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // ── Content verification ─────────────────────────────────────────────

  it("memory files contain meaningful content (not empty)", () => {
    const agents = ["Auditor", "Builder", "Fetcher", "Planner", "Scribe", "Scout", "Tester"]
    for (const agent of agents) {
      const path = join(MEMORY_DIR, `${agent}.md`)
      const content = readFileSync(path, "utf-8").trim()
      expect(content.length, `${agent}.md should have content`).toBeGreaterThan(100)
    }
  })

  it("SCRIBE_OVERLAY mentions memory responsibility", () => {
    const personasPath = join(__dirname, "..", "personas.ts")
    const content = readFileSync(personasPath, "utf-8")
    expect(content).toContain("MEMORY RESPONSIBILITY")
    expect(content).toContain("agent_memory")
    expect(content).toContain("4KB")
  })

  it("ROOM_NOTE mentions agent memory", () => {
    const participantPath = join(__dirname, "..", "participant.ts")
    const content = readFileSync(participantPath, "utf-8")
    expect(content).toContain("agent_memory")
    expect(content).toContain("your_id")
    expect(content).toContain("compaction")
  })
})
