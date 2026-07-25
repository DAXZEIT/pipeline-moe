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
 *
 * Two KINDS of check live here, and the distinction is load-bearing (first CI
 * run, 2026-07-25, run 30159393336): `agent_memory/` is gitignored runtime
 * state written by the scribe, so the checks that read it assert on THIS
 * machine's install, not on code. They failed 5/9 on a clean checkout — i.e.
 * they would fail for any contributor cloning the repo, and "1386 green" was
 * really 1381 tests plus 5 assertions that only pass where agents have already
 * run. They keep their value as a LOCAL health guard (a ballooned or emptied
 * memory file is a real operational problem), so they are gated on the
 * directory existing rather than deleted. Anything testing injection LOGIC
 * builds its own fixture and runs everywhere.
 */
const HAS_LIVE_MEMORY = existsSync(MEMORY_DIR)

describe("memory injection", () => {
  // ── Local health guard: reads the live, gitignored agent_memory/ ──────
  // Skipped where that directory doesn't exist (CI, fresh clone).

  it.skipIf(!HAS_LIVE_MEMORY)("agent memory files exist for all active personas", () => {
    const expectedAgents = ["auditor", "builder", "fetcher", "planner", "scribe", "scout", "tester"]
    for (const agent of expectedAgents) {
      const path = join(MEMORY_DIR, `${agent}.md`)
      expect(existsSync(path), `${agent}.md should exist`).toBe(true)
    }
  })

  it.skipIf(!HAS_LIVE_MEMORY)("each memory file is under 32KB (anti-ballooning guard)", () => {
    // The 4KB injection truncation is tested separately in 'injection truncates files over 4KB'.
    // This test guards against runaway growth — files naturally grow past 4KB as the scribe
    // accumulates history, but should never balloon to multi-MB size.
    const agents = ["auditor", "builder", "fetcher", "planner", "scribe", "scout", "tester"]
    for (const agent of agents) {
      const path = join(MEMORY_DIR, `${agent}.md`)
      const content = readFileSync(path, "utf-8")
      expect(content.length, `${agent}.md should be under 32KB`).toBeLessThan(32768)
    }
  })

  it.skipIf(!HAS_LIVE_MEMORY)("README.md exists and documents the system", () => {
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

  // Formatting is injection LOGIC, so it builds its own fixture instead of
  // reading the live builder.md — a format assertion has no reason to depend on
  // whether this machine's scribe has ever written anything.
  it("injection produces correct format for existing file", () => {
    const tmpDir = join(__dirname, "..", "..", "tmp_test_memory_format")
    try {
      mkdirSync(tmpDir, { recursive: true })
      writeFileSync(join(tmpDir, "builder.md"), "# Builder notes\nfirst line of memory\n")

      const note = buildMemoryNote("builder", tmpDir)
      expect(note).toContain("YOUR MEMORY (agent_memory/builder.md):")
      expect(note).toContain("---")
      expect(note).toContain("End of memory — updated by the scribe")
      expect(note).toContain("After compaction, this is refreshed")
      // The file's content is carried through, not dropped.
      expect(note).toContain("# Builder notes")
      expect(note).toContain("first line of memory")
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
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

  it.skipIf(!HAS_LIVE_MEMORY)("memory files contain meaningful content (not empty)", () => {
    const agents = ["auditor", "builder", "fetcher", "planner", "scribe", "scout", "tester"]
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
    // ROOM_NOTE and the memory/logbook injection moved to seat-runtime.ts —
    // the SeatRuntime owns session construction (fused seats phase 1).
    const seatRuntimePath = join(__dirname, "..", "seat-runtime.ts")
    const content = readFileSync(seatRuntimePath, "utf-8")
    expect(content).toContain("agent_memory")
    expect(content).toContain("your_id")
    expect(content).toContain("compaction")
  })
})
