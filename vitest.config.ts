import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts", "packages/*/src/__tests__/**/*.test.ts"],
    environment: "node",
    // Hermetic workspace. config.ts defaults workspaceDir to process.cwd(), so
    // room tests would receipt-snapshot the whole repo around every simulated
    // turn — untracked junk in the checkout (a 69M site/, workspace
    // experiments) once quadrupled that walk and blew the room tests' timing
    // budgets, 69 failures across 14 files. A throwaway tmpdir keeps the suite
    // independent of whatever the repo has lying around.
    env: { WORKSPACE_DIR: mkdtempSync(join(tmpdir(), "pmoe-test-ws-")) },
  },
})
