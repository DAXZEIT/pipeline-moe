/**
 * Human display form of a model ref, shorter than shortModel(): drops the
 * provider/org path, vendor words the id repeats ("minimax/minimax-m3" → M3),
 * the "claude-" family prefix, variant tags (":free"), .gguf and quant
 * suffixes, then title-cases and folds version runs — so
 * "anthropic/claude-opus-4-8" reads "Opus 4.8" and fits in a roster cell.
 */
export function prettyModel(ref: string): string {
  // "provider/id" — the id may itself be a path (openrouter/deepseek/deepseek-v4-flash).
  const id = ref.slice(ref.indexOf("/") + 1)
  let tail = id.split("/").pop() ?? id
  tail = tail.replace(/:[\w-]+$/, "")
  tail = tail.replace(/\.gguf$/i, "")
  tail = tail.replace(/-i?q\d[\w.]*$/i, "")
  const tokens = tail.split("-").filter(Boolean)
  // Vendor words: any path segment of the ref, plus Claude's family prefix.
  const vendors = new Set(ref.toLowerCase().split("/").slice(0, -1))
  vendors.add("claude")
  while (tokens.length > 1 && vendors.has(tokens[0].toLowerCase())) tokens.shift()
  // Fold trailing digit runs into a dotted version: opus 4 8 → opus 4.8.
  const out: string[] = []
  for (const t of tokens) {
    const prev = out[out.length - 1]
    if (/^\d+$/.test(t) && prev !== undefined && /^\d+(\.\d+)*$/.test(prev)) out[out.length - 1] = `${prev}.${t}`
    else out.push(t)
  }
  return out.map((t) => t[0].toUpperCase() + t.slice(1)).join(" ")
}
