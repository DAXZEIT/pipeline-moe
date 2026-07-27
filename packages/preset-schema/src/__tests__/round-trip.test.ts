import { readdirSync, readFileSync } from "node:fs"
import { resolve, dirname, extname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { validatePreset } from "../index.js"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const PRESETS = resolve(ROOT, "presets")
const NAMES = readdirSync(PRESETS).filter((f) => extname(f) === ".json").sort()

describe("gate — every real preset file is accepted", () => {
  it("presets directory was read", () => {
    // Empty guard only — a 17th preset must not fail the suite; an empty read does.
    expect(NAMES.length).toBeGreaterThan(0)
  })

  it.each(NAMES)("%s", (name) => {
    const doc = JSON.parse(readFileSync(resolve(PRESETS, name), "utf8"))
    // The gate's weight-bearing assertion: the schema accepts all real files.
    // Falsifiable — a wrong schema rejects a real file.
    expect(validatePreset(doc).ok, "validation failed").toBe(true)
  })
})
