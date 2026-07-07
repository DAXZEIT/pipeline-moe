import type { RosterItem } from "@pipeline-moe/client-core"

/** Compact number format: 42000 → "42K", 1200 → "1.2K" */
export function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`
  return String(n)
}

/** Stats line: "43K/1000K · cache 76%" or null when no stats exist. */
export function statsLine(r: RosterItem): string | null {
  const ctx = r.contextUsage
  const st = r.sessionStats
  if (!ctx && !st) return null

  const t = ctx?.tokens != null ? fmt(ctx.tokens) : "—"
  const w = ctx?.contextWindow != null ? fmt(ctx.contextWindow) : "—"

  const cachePct = st?.tokens?.total != null && st.tokens.total > 0
    ? Math.round((st.tokens.cacheRead / st.tokens.total) * 100)
    : null

  const parts: string[] = []
  parts.push(`${t}/${w}`)
  if (cachePct != null) parts.push(`cache ${cachePct}%`)

  return parts.join(" · ")
}
