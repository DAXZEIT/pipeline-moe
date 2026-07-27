// The JSON Schema export is the deliverable for consumers OUTSIDE the TypeBox
// ecosystem (site/, OpenAPI tooling) — and it was the one export nothing
// exercised: every other test drives `validatePreset`, i.e. the TypeBox path.
//
// Two properties matter, and neither is provable by asserting the `$schema`
// string against the constant that set it:
//   1. the declared dialect is real — a draft-2020-12 validator compiles it,
//      in strict mode, with no unknown or misplaced keywords;
//   2. it means the same thing as `validatePreset` — otherwise a consumer
//      validating with the export would accept presets the server rejects.

import { readdirSync, readFileSync } from "node:fs"
import { resolve, dirname, extname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import Ajv2020 from "ajv/dist/2020.js"
import { validatePreset, presetJsonSchema } from "../index.js"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const PRESETS = resolve(ROOT, "presets")
const NAMES = readdirSync(PRESETS).filter((f) => extname(f) === ".json").sort()
const readDoc = (name: string) => JSON.parse(readFileSync(resolve(PRESETS, name), "utf8"))

const DIALECT = "https://json-schema.org/draft/2020-12/schema"

// strict:true is the point — it rejects unknown keywords and keywords applied
// to the wrong type, so a schema that only *looks* like 2020-12 fails here.
const ajv = new Ajv2020({ strict: true, allErrors: true })
const compiled = ajv.compile(presetJsonSchema as object)

/** The corruption classes of negative-control.test.ts, reused so the two
 *  validators are compared on rejection as well as acceptance. */
const CORRUPTIONS: [string, (doc: any) => void][] = [
  ["drop persona[0].name", (d) => delete d.personas[0].name],
  ["unknown persona field", (d) => { d.personas[0].bogus = true }],
  ["unknown top-level field", (d) => { d.bogusTop = true }],
  ["active as string", (d) => { d.personas[0].active = "yes" }],
  ["tools as scalar", (d) => { d.personas[0].tools = "read" }],
  ["bad thinkingLevel", (d) => { d.personas[0].thinkingLevel = "ultra" }],
  ["drop personas array", (d) => delete d.personas],
  ["empty personas", (d) => { d.personas = [] }],
  ["float cursor", (d) => { d.personas[0].cursor = 1.5 }],
  ["gate without via", (d) => { d.handoffGates = [{ from: "a" }] }],
]

describe("JSON Schema export — usable outside TypeBox", () => {
  it("declares the dialect a real 2020-12 validator compiled it under", () => {
    // Meaningful only as a pair: the compile above proves 2020-12 accepts the
    // schema, this pins the export to the dialect that was actually exercised.
    expect((presetJsonSchema as Record<string, unknown>).$schema).toBe(DIALECT)
  })

  it("keeps every constraint through the Symbol strip", () => {
    const text = JSON.stringify(presetJsonSchema)
    expect(text).not.toContain("Symbol(")
    // file, persona, gate — losing one silently reopens the schema.
    expect(text.match(/additionalProperties/g)).toHaveLength(3)
    expect(text).toContain("minItems")
    expect(text).toContain('"integer"')
  })

  describe("agrees with validatePreset on every real file", () => {
    it.each(NAMES)("%s: both accept", (name) => {
      const doc = readDoc(name)
      expect(compiled(doc)).toBe(true)
      expect(validatePreset(doc).ok).toBe(true)
    })
  })

  describe("agrees with validatePreset on every corruption", () => {
    it.each(CORRUPTIONS.map(([label], i) => [label, i] as const))(
      "%s: both reject",
      (_label, i) => {
        const mutate = CORRUPTIONS[i][1]
        for (const name of NAMES) {
          const doc = structuredClone(readDoc(name))
          mutate(doc)
          expect(compiled(doc), `${name}: ajv accepted a corruption`).toBe(false)
          expect(validatePreset(doc).ok, `${name}: typebox accepted a corruption`).toBe(false)
        }
      },
    )
  })
})
