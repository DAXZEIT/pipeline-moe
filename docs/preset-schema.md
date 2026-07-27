# Preset schema — one source of truth for the preset file format

> Idea: Dax brief (extract the preset format into a published
> `@pipeline-moe/preset-schema`, consumed later by the server and `site/`).
> Status: **built, verified, and remediated; not yet adopted.** This pass ships the
> package + evidence only; rewiring the server or the site onto it is a
> separate chantier gated on this ADR being reviewed.

## The problem in one line

The same object — a persona as persisted in `presets/*.json` — was defined
three times over, and the copies had already drifted. The package
`@pipeline-moe/preset-schema` (modelled on `packages/client-core`) is now
the single definition: TypeScript types, a non-transforming runtime
validator with typed errors, and an emitted JSON Schema.

## The three definitions that disagreed

| Locus | What it is | Note |
|---|---|---|
| `src/types.ts` → `Persona` | The **runtime** persona. `systemPrompt` REQUIRED; no `active`/`parallel`/`cursor`. | A live roster entry, not a file row. |
| `src/preset-hydration.ts` → `PresetPersona` | The **on-disk** persona. `Omit<PersonaState,"systemPrompt"> & {systemPrompt?}` — inherits `active`(req), `parallel?`, `cursor?`, `seat?`. `src/server.ts` and `src/validation.ts` both import this one type. | The shape the server actually reads/writes. |
| `site/src/types.ts` → `PresetPersona`/`PresetFile` | A **hand copy**, self-declared temporary. Omits `seat`, `cursor`; its `PresetFile` omits `handoffGates`. | Predates fused seats; this is the copy that drifted. |

Ground truth is the 16 files in `presets/` (83 personas). They were read
from disk and are the test, not fixtures we wrote.

## Disagreements and winners

For every field where the definitions disagreed, which one the schema
encodes and why. Disk is the tiebreaker.

| Field | Runtime `Persona` | On-disk `PresetPersona` | Site copy | On disk (83 personas) | **Winner** | Why |
|---|---|---|---|---|---|---|
| `systemPrompt` | required | optional | optional | absent 76/83 | **optional** | Preset personas rehydrate the prompt from the seed at load; only the live runtime `Persona` needs it populated. |
| `seat` | present | present | **absent** | 8 | **optional** | Site copy predates fused seats (`docs/fused-seats.md`); disk + server are authoritative. |
| `cursor` | — | present ("runtime-only") | **absent** | 14 (always `0`) | **optional** | Disk is ground truth, so the schema accepts it. ⚠ Tension: `preset-hydration.ts` lists `cursor` in `RUNTIME_ONLY_FIELDS` and strips it for drift comparison, yet it is serialized into saved files. The schema carries it with no semantic weight; a future save-path could stop writing it. |
| `active` | — | required | required | 83/83 | **required** | Both preset shapes and every file agree. |
| `parallel` | — | optional | optional | 83/83 | **optional** | Both definitions declare it optional; the schema models the *contract* (a hand-authored preset may omit it), not just the current files, which happen to always set it. |
| `handoffGates` (top level) | — | present | **absent** | 9/16 files | **optional** | The server owns preset I/O and writes gates; the site never does. |
| `vision`, `skills` | present | present | present | **0/83** | **optional, kept** | Legitimate server-written fields. Absent on disk only because `stripSeedFields` removes seed-identical `skills` and no preset overrides `vision`. |
| `presetVersion` | — | — | — | nowhere | **NOT added** | `idea.md` §6 proposes it, but nothing writes or reads a version yet and no breaking change exists to version — adding an unused optional field is speculative surface (YAGNI). The ground-truth constraint is *not* the reason: a field added to the **schema** adds no bytes to any preset file. Defer until the first breaking change that needs it, alongside the migration for the existing files. |

## Validator choice: TypeBox, not Zod

`idea.md` §6 suggested Zod. We used **TypeBox** (`typebox@^1.2.16`):

- It is **already a root dependency** of this repo. Zod is installed
  nowhere. Adding a dependency the repo lacks needs a reason; we had none.
- TypeBox **emits JSON Schema natively** — the schema object *is* a JSON
  Schema (plus internal symbols, stripped for the `presetJsonSchema`
  export). One definition yields both the typed validator and the JSON
  Schema deliverable, with no second source to keep in sync.

API specifics that matter for the next reader (all cost a build stall if
missed, verified against 1.2.16):

- `Value` lives at `typebox/value`, not the top-level export.
- Errors are **AJV-style**: `{ keyword, schemaPath, instancePath, params,
  message }`. There is **no `path` property**. Offending names are batched
  arrays in `params` — `params.additionalProperties: string[]` and
  `params.requiredProperties: string[]` (one error per object, listing all
  extra/missing keys). `validatePreset` expands those arrays into
  per-property JSON-Path strings (`/personas/0/name`, `/bogus`).
- `additionalProperties: false` must be set explicitly on every
  `Type.Object`, or `Value.Check` silently accepts unknown fields. All
  three objects (file, persona, gate) set it.

## Non-transforming by contract

`validatePreset` is a **pure predicate**: it runs `Value.Check` and returns
the *input object itself* (identity, insertion order intact) on success. It
never calls `Value.Clean`/`Convert`/`Cast`/`Decode`, and deliberately
replicates none of the server `parsePresetFile`'s transformations (trimming
whitespace, dropping empty `systemPrompt`, dropping blank `seat`, trimming
gate fields). The identity contract is guarded directly in `validate.test.ts`
(`expect(r.value).toBe(input)` — a real check, which would fail if the
validator ever returned a clone).

### What the gate actually proves

The gate's weight-bearing assertion is **acceptance**: for every file in
`presets/`, `validatePreset(JSON.parse(file)).ok === true`, one test per file
so a regression reports every failing file, not just the first. This is
falsifiable — a schema that wrongly rejected a real preset would fail it.
Acceptance alone would also pass an all-permissive schema, so a **negative
control** (`negative-control.test.ts`) supplies the other half: for each real
file it derives corrupted copies *in memory* (dropped required field, unknown
field, wrong type, bad enum, empty roster, float cursor, …) and asserts
rejection with the expected error path. Loosen the schema and the negative
control fails — that is its purpose. Files on disk are never modified.

A subtlety worth recording because it cost a pass to see: an earlier version
of the gate also re-serialized the validated value and compared it to the
file. Under the identity contract that comparison is a **tautology** —
`result.value` *is* `JSON.parse(file)`, so it compares an object to itself
and cannot fail for any input; its failure message described something it
could not detect. It was removed. The on-disk formatting drift it was once
blamed on catching is real but irrelevant to a test that does not byte-compare:
12 files end `\n` while 4 (`3X2seats`, `NEWMAIN`, `seat-arena`,
`seat-arena-defused`) end `}`, and `pi-audited`/`relay-local`/`relay-local-9b`
use inline arrays.

A behavioral note worth recording: `pi-audited.json` carries
`"systemPrompt": ""`. The server's `parsePresetFile` **drops** that empty
string; the schema validator **preserves** it. The schema is the more
faithful reader — it reports what is in the file, and leaves normalization
to whoever adopts it.

## Structural validation only — semantic checks stay server-side

The schema validates **structure**, not meaning. These constraints are real
but cannot be expressed cleanly in JSON Schema, and remain the server's
responsibility (today in `src/validation.ts` / `src/seats.ts`):

- **Duplicate persona ids** — `parsePresetFile` rejects a repeated `id`.
- **Seat-model consistency** — every hat of a seat must resolve to the same
  model (`validateSeatModels`); a violation defuses the seat at room load.
- **Tool allowlist membership** — tools are checked against `VALID_TOOLS`.

Two constraints that *look* semantic are in fact structural and ARE enforced
by the schema (decided this remediation pass; both one-line, both keep 16/16
green):

- **Non-empty roster** — `personas` carries `minItems: 1`, matching the
  server's `personas.length > 0` requirement.
- **Integer cursor** — `cursor` is `Type.Integer()`, not `Type.Number()`; it
  is a transcript index, never a fraction (every on-disk cursor is `0`).

These are JSON-Schema-expressible, unlike the three above — which is exactly
the line between "schema" and "stays server-side."

A future consumer (notably `site/`) must not assume the schema enforces
these. Adopting the package means wiring its structural validation *plus*
keeping the server's semantic layer.

## Field reference

Required: `id`, `name`, `color`, `icon`, `tools`, `active` (persona);
`name`, `personas` (file).
Optional: `systemPrompt`, `model`, `thinkingLevel` (6-value enum:
off/minimal/low/medium/high/xhigh — disk only uses `high`/`medium`),
`compactionInstructions`, `vision`, `skills`, `seat`, `parallel`, `cursor`
(persona); `handoffGates` (file, `{from, via, when?}`).
`model` is free-form (values contain spaces and colons, e.g.
`local/GRM 2.6`, `openrouter/...:free`) — no pattern constraint.
`personas` has `minItems: 1`; `cursor` is an integer. The exported
`presetJsonSchema` declares its dialect — `$schema:
"https://json-schema.org/draft/2020-12/schema"` (TypeBox 1.x targets draft
2020-12; the emitted schema carried no `$schema` until it was added).

## Evidence

- 199 package tests pass under the root vitest: a per-file **acceptance
  gate** over all 16 `presets/*.json` (`validatePreset(file).ok === true`),
  a 144-test **negative control** (9 corruption classes × 16 files, each
  rejected with the expected error path, derived in memory — disk untouched),
  10 unit tests (identity contract, typed error paths), and a **JSON Schema
  export** suite. Package `typecheck` and `build` exit 0.
- The export suite (`json-schema.test.ts`) closes the last untested
  deliverable: every other test drives `validatePreset`, i.e. the TypeBox
  path, while `presetJsonSchema` is what `site/` and OpenAPI tooling would
  actually consume. It compiles the export under **Ajv 2020 in strict mode**
  — which rejects a wrongly declared dialect and misplaced keywords, so the
  `$schema` value is verified rather than restated — and cross-checks that
  Ajv and `validatePreset` return the same verdict on all 16 real files and
  on all 10 corruption classes. A drift between the two would let a consumer
  accept presets the server rejects.
- `git status --porcelain presets/` shows zero modifications — only the two
  pre-existing untracked files (`3X2seats.json`, `NEWMAIN.json`).

## Follow-ups (not this pass)

- **Adoption** — rewire `src/server.ts`/`src/validation.ts` and `site/` onto
  the package; delete the hand copies. Separate chantier, gated on review.
- **`presetVersion`** — add when the format first needs a breaking change,
  with a migration for the 16 existing files.
- **`cursor` on disk** — decide whether the save path should stop
  serializing this runtime field (it is stripped for drift anyway).
