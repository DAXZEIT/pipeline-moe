import { Box, Text } from "ink"
import type { RosterItem } from "@pipeline-moe/client-core"
import { shortModel } from "../commands/registry"
import { useTerminalSize } from "../useTerminalSize"

const STATUS_GLYPH: Record<RosterItem["status"], string> = {
  idle: "○",
  active: "●",
  thinking: "◐",
  working: "◑",
  compacting: "◒",
  retrying: "↻",
}

/** Compact number format: 42000 → "42K", 1200 → "1.2K" */
function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`
  return String(n)
}

/** Stats line: "43K/1000K · cache 76%" or null when no stats exist. */
function statsLine(r: RosterItem): string | null {
  const ctx = r.contextUsage
  const st = r.sessionStats
  if (!ctx && !st) return null

  // Context usage: "43K/1000K" — use tokens if available, else "—"
  const t = ctx?.tokens != null ? fmt(ctx.tokens) : "—"
  const w = ctx?.contextWindow != null ? fmt(ctx.contextWindow) : "—"

  // Cache hit from session stats: cacheRead / total * 100
  const cachePct = st?.tokens?.total != null && st.tokens.total > 0
    ? Math.round((st.tokens.cacheRead / st.tokens.total) * 100)
    : null

  const parts: string[] = []
  parts.push(`${t}/${w}`)
  if (cachePct != null) parts.push(`cache ${cachePct}%`)

  return parts.join(" · ")
}

export function Roster({ roster, width }: { roster: RosterItem[]; width: number }) {
  const activeCount = roster.filter((r) => r.active).length

  // Three-tier height heuristic: full = model + stats (3 lines/agent),
  // models = model only (2 lines), compact = name only (1 line).
  // Header takes 2 lines (title + blank); reserve 8 rows for transcript + chrome.
  const { rows } = useTerminalSize()
  const available = rows - 8
  const detail: "full" | "models" | "compact" =
    roster.length * 3 + 2 <= available ? "full"
    : roster.length * 2 + 2 <= available ? "models"
    : "compact"

  const showModels = detail !== "compact"
  const showStats = detail === "full"

  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold color="cyan">
        ROSTER {activeCount}/{roster.length}
      </Text>
      {roster.map((p) => {
        const sl = showStats ? statsLine(p) : null
        return (
          <Box key={p.id} flexDirection="column">
            <Text color={p.active ? p.color : "gray"} dimColor={!p.active}>
              {STATUS_GLYPH[p.status]} {p.icon} {p.name}
            </Text>
            {showModels ? (
              <Text dimColor wrap="truncate-end">
                {"  "}
                {p.model ? (p.model.startsWith("local/") ? "🖥 " : "☁ ") : ""}
                {shortModel(p.model) ?? "default"}
              </Text>
            ) : null}
            {sl != null ? (
              <Text dimColor color={p.contextUsage?.percent != null && p.contextUsage.percent > 80 ? "yellow" : undefined} wrap="truncate-end">
                {"  "}{sl}
              </Text>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}
