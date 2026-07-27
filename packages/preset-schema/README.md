# @pipeline-moe/preset-schema

Single source of truth for the pipeline-moe preset file format — the shape of
the JSON files in `presets/`. Exports the TypeScript types, a non-transforming
runtime validator with typed errors, and the JSON Schema (draft 2020-12)
emitted from it. Meant to be consumed by the server and the preset-builder
site so neither can drift from the format again.

## Usage

```ts
import { validatePreset, presetJsonSchema } from "@pipeline-moe/preset-schema"

const result = validatePreset(JSON.parse(text))
if (result.ok) {
  result.value // typed PresetFile — the SAME object you passed in
} else {
  result.errors // [{ path: "/personas/0/name", message: "..." }, ...]
}
```

`validatePreset` is a pure predicate: on success it returns the input object
itself (identity, insertion order intact). It never rewrites, trims, or
reorders — a validated preset re-serializes to exactly what was read.

## Exports

- `validatePreset(input)` → `{ ok: true, value } | { ok: false, errors }`
- `presetSchema` — the TypeBox schema
- `presetJsonSchema` — plain JSON Schema object; declares
  `$schema: "https://json-schema.org/draft/2020-12/schema"`
- Types: `PresetFile`, `PresetPersona`, `HandoffGate`, `ThinkingLevel`,
  `TypedError`, `ValidationResult`

## Scope

Structural validation only (required fields, closed objects, types, enums,
`minItems: 1`, integer `cursor`). Semantic checks — duplicate persona ids,
seat-model consistency, tool-allowlist membership — stay with the server. See
`docs/preset-schema.md` for the field-by-field decisions and the
TypeBox-over-Zod choice.

## Development

```bash
npm run build       # tsc -> dist
npm run typecheck   # tsc --noEmit
```

Tests run under the root vitest (`packages/preset-schema/src/__tests__/`):
a per-file acceptance gate over every real preset, a real-file-driven negative
control, unit tests, and an export suite that compiles `presetJsonSchema` under
Ajv 2020 in strict mode and checks it agrees with `validatePreset` on every real
file and every corruption class. The real files in `presets/` are the ground
truth and are never modified.
