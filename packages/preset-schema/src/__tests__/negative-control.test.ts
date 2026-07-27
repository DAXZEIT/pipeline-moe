import { readdirSync, readFileSync } from "node:fs"
import { resolve, dirname, extname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { validatePreset } from "../index.js"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const PRESETS = resolve(ROOT, "presets")
const NAMES = readdirSync(PRESETS).filter((f) => extname(f) === ".json").sort()
const readDoc = (name: string) => JSON.parse(readFileSync(resolve(PRESETS, name), "utf8"))

/** Derive a corrupted copy of a real preset in memory and assert rejection.
 *  Each class maps to one enforcement axis the schema claims.
 *  The control FAILS if the schema is loosened (e.g. additionalProperties:true),
 *  which is its purpose — it proves the gate is not an all-permissive schema. */
function corrupt(name: string, transform: (clone: unknown) => void, expectPath: string) {
  const doc = readDoc(name)
  const clone = structuredClone(doc)
  transform(clone)
  const r = validatePreset(clone)
  expect(r.ok, "should reject").toBe(false)
  if (r.ok) return
  expect(r.errors.map((e) => e.path)).toContain(expectPath)
}

describe("negative control — real files rejected when corrupted (in memory)", () => {
  describe("required persona fields", () => {
    it.each(NAMES)("%s: drop persona[0].name", (name) =>
      corrupt(name, (doc) => {
        const p = (doc as any).personas[0]
        delete p.name
      }, "/personas/0/name"),
    )
  })

  describe("closed objects (additionalProperties:false)", () => {
    it.each(NAMES)("%s: unknown persona field", (name) =>
      corrupt(name, (doc) => {
        ;(doc as any).personas[0].bogus = true
      }, "/personas/0/bogus"),
    )
    it.each(NAMES)("%s: unknown top-level field", (name) =>
      corrupt(name, (doc) => {
        ;(doc as any).bogusTop = true
      }, "/bogusTop"),
    )
  })

  describe("type enforcement", () => {
    it.each(NAMES)("%s: active as string", (name) =>
      corrupt(name, (doc) => {
        ;(doc as any).personas[0].active = "yes"
      }, "/personas/0/active"),
    )
    it.each(NAMES)("%s: tools as scalar", (name) =>
      corrupt(name, (doc) => {
        ;(doc as any).personas[0].tools = "read"
      }, "/personas/0/tools"),
    )
  })

  describe("enum enforcement", () => {
    it.each(NAMES)("%s: bad thinkingLevel", (name) =>
      corrupt(name, (doc) => {
        ;(doc as any).personas[0].thinkingLevel = "ultra"
      }, "/personas/0/thinkingLevel"),
    )
  })

  describe("top-level structure", () => {
    it.each(NAMES)("%s: drop personas array", (name) =>
      corrupt(name, (doc) => {
        delete (doc as any).personas
      }, "/personas"),
    )
  })

  describe("Item 6 tightening: minItems + integer", () => {
    it.each(NAMES)("%s: empty personas (minItems:1)", (name) =>
      corrupt(name, (doc) => {
        ;(doc as any).personas = []
      }, "/personas"),
    )
    it.each(NAMES)("%s: float cursor (Type.Integer)", (name) =>
      corrupt(name, (doc) => {
        ;(doc as any).personas[0].cursor = 1.5
      }, "/personas/0/cursor"),
    )
  })
})
