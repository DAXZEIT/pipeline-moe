// config.ts reads the environment at import time, so each case sets PORT and
// re-imports the module fresh (vi.resetModules). Under vitest the .env load is
// skipped, so process.env is the only input.

import { afterEach, expect, test, vi } from "vitest"

const loadConfig = async () => {
  vi.resetModules()
  return (await import("../config.js")).config
}

afterEach(() => {
  delete process.env.PORT
})

test("PORT=abc fails fast with a clear error", async () => {
  process.env.PORT = "abc"
  await expect(loadConfig()).rejects.toThrow('PORT must be a number, got "abc"')
})

test("a valid PORT is used as-is", async () => {
  process.env.PORT = "5432"
  const config = await loadConfig()
  expect(config.port).toBe(5432)
})

test("PORT unset falls back to 5300", async () => {
  const config = await loadConfig()
  expect(config.port).toBe(5300)
})
