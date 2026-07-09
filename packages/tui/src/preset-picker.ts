import type { PresetFile } from "@pipeline-moe/client-core"

/** The icon-string + count summary shown next to each preset in the list —
 *  same content previously built inline in commands/registry.ts's
 *  openPresetPicker, now shared so the picker and any future summary view
 *  render it identically. */
export function presetSummary(preset: PresetFile): string {
  const n = preset.personas.length
  return preset.personas.map((p) => p.icon).join("") + `  ${n} agent${n === 1 ? "" : "s"}`
}

/** How many list rows vs preview persona rows fit in the terminal, given the
 *  fixed chrome this overlay always draws (title + footer + a blank spacer
 *  between the two sections, on top of Ink's own border rows). The list gets
 *  a small ceiling — arrow keys do the work, there's rarely a reason to see
 *  more than a handful of preset names at once — and the preview gets
 *  whatever's left, since a live per-agent preview is the actual point of
 *  merging the old list+detail flow into one overlay. Both floor at a usable
 *  minimum so a short terminal still shows *something* instead of 0 rows. */
export function presetPickerLayout(rows: number, presetCount: number): { listVisible: number; previewMax: number } {
  const budget = Math.max(8, rows - 10)
  const listVisible = Math.max(1, Math.min(4, presetCount))
  const previewMax = Math.max(2, budget - listVisible - 3 /* title + spacer + footer */)
  return { listVisible, previewMax }
}

/** Persona-preview budget for the create-room form (RoomForm). Unlike the
 *  full-screen picker, the form already draws ~13 rows of fixed chrome
 *  (border, title, four fields, create button + its spacer, error slot,
 *  footer), and the preview is a confirmation aid, not the main event — so
 *  it is capped low to keep the form compact, and floors at 2 so a selected
 *  preset always shows at least a hint of its roster on short terminals. */
export function roomFormPreviewMax(rows: number): number {
  return Math.max(2, Math.min(8, rows - 13))
}

/** Truncate a preset's persona list to what the preview panel has room for,
 *  reporting how many were cut so the UI can render "+N more agents". */
export function previewPersonas(
  preset: PresetFile | undefined,
  max: number,
): { shown: PresetFile["personas"]; hidden: number } {
  if (!preset) return { shown: [], hidden: 0 }
  const shown = preset.personas.slice(0, max)
  return { shown, hidden: preset.personas.length - shown.length }
}
