import { Box, Text, useInput } from "ink"
import { useMemo, useState } from "react"
import stringWidth from "string-width"
import {
  deriveHandoffChain,
  deriveHandoffGraph,
  dominantType,
  USER_NODE,
  type HandoffChainStep,
  type HandoffGraph,
  type HandoffNode,
  type HandoffType,
  type Message,
  type RosterItem,
} from "@pipeline-moe/client-core"
import { useTerminalSize } from "../../useTerminalSize"

/** Ink color per transition type — mirrors the web graph's edge palette. */
const TYPE_COLOR: Record<HandoffType, string> = {
  handoff: "gray",
  route: "cyan",
  hatswitch: "green",
}
const TYPE_LABEL: Record<HandoffType, string> = {
  handoff: "handoff",
  route: "route",
  hatswitch: "hat-switch",
}

/** Pad a display string (emoji-aware) to `width` columns with trailing spaces. */
function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - stringWidth(s)))
}
function padStart(s: string, width: number): string {
  return " ".repeat(Math.max(0, width - stringWidth(s))) + s
}

const seatLabel = (n: HandoffNode | HandoffChainStep): string =>
  `${n.icon} ${n.id === USER_NODE ? "you" : n.name}`

/**
 * `/graph` — the room's handoffs, terminal-native. Two reads of the same live
 * transcript: `trace` (the literal path the turn walked —
 * `you → planner → builder → tester → planner → auditor`, arrows tinted by hop
 * kind) and `flows` (the ranked ledger — who passed to whom, how often). Esc
 * closes. A grid was tried and dropped: emoji column widths never align in a
 * terminal, and the snake reads better anyway.
 */
export function GraphOverlay({
  messages,
  roster,
  onClose,
  isActive,
  initialView = "trace",
}: {
  messages: Message[]
  roster: RosterItem[]
  onClose: () => void
  isActive: boolean
  /** Which read opens first; `f`/`t` switch freely after. */
  initialView?: "flows" | "trace"
}) {
  const graph = useMemo(() => deriveHandoffGraph(messages, roster), [messages, roster])
  const chain = useMemo(() => deriveHandoffChain(messages, roster), [messages, roster])
  const [view, setView] = useState<"flows" | "trace">(initialView)
  const [offset, setOffset] = useState(0)
  const { rows } = useTerminalSize()

  useInput(
    (input, key) => {
      if (key.escape || input === "q") return onClose()
      if (input === "f") return setView("flows")
      if (input === "t") return setView("trace")
      if (key.upArrow) return setOffset((o) => Math.max(0, o - 1))
      if (key.downArrow) return setOffset((o) => o + 1)
    },
    { isActive },
  )

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes])
  const node = (id: string): HandoffNode =>
    byId.get(id) ?? { id, name: id, color: "gray", icon: "•", turns: 0 }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          HANDOFF GRAPH{" "}
          <Text color="gray">
            · {graph.total} handoff{graph.total === 1 ? "" : "s"} · {graph.nodes.length} seat
            {graph.nodes.length === 1 ? "" : "s"}
          </Text>
        </Text>
        <Text>
          <Text color={view === "trace" ? "cyan" : "gray"} bold={view === "trace"}>
            [t]race
          </Text>
          <Text color="gray"> / </Text>
          <Text color={view === "flows" ? "cyan" : "gray"} bold={view === "flows"}>
            [f]lows
          </Text>
        </Text>
      </Box>

      {graph.edges.length === 0 ? (
        <Text dimColor>No handoffs yet — the graph draws itself as seats pass the turn.</Text>
      ) : view === "trace" ? (
        <Trace chain={chain} rows={rows} offset={offset} setOffset={setOffset} />
      ) : (
        <Flows graph={graph} node={node} rows={rows} offset={offset} setOffset={setOffset} />
      )}

      <Text dimColor>↑↓ scroll · t trace · f flows · esc close</Text>
    </Box>
  )
}

// ── Trace: the turn's path, one numbered hop per line ────────────────────────

function Trace({
  chain,
  rows,
  offset,
  setOffset,
}: {
  chain: HandoffChainStep[]
  rows: number
  offset: number
  setOffset: (fn: (o: number) => number) => void
}) {
  // One hop per line, numbered — a 30-hop run is a wall of arrows horizontally,
  // but a readable journal vertically. Head-anchored + scroll, like the task
  // board and the flows list.
  const idxW = String(chain.length).length
  const nameW = Math.max(...chain.map((s) => stringWidth(seatLabel(s))))
  const maxVisible = Math.max(3, Math.min(chain.length, rows - 10))
  const maxOffset = Math.max(0, chain.length - maxVisible)
  const start = Math.min(offset, maxOffset)
  if (offset > maxOffset) setOffset(() => maxOffset)
  const shown = chain.map((s, i) => ({ s, i })).slice(start, start + maxVisible)

  return (
    <Box flexDirection="column" marginY={1}>
      <Text dimColor>{start > 0 ? "     ▲ earlier" : " "}</Text>
      {shown.map(({ s, i }) => (
        <Text key={i}>
          <Text dimColor>{padStart(String(i + 1), idxW)}  </Text>
          {i === 0 ? (
            <Text dimColor>  </Text>
          ) : (
            <Text color={s.type ? TYPE_COLOR[s.type] : "gray"} bold>
              ↳{" "}
            </Text>
          )}
          <Text color={s.color}>{pad(seatLabel(s), nameW)}</Text>
          {i === 0 ? (
            <Text dimColor>   start</Text>
          ) : s.type ? (
            <Text color={TYPE_COLOR[s.type]} dimColor>
              {"   "}
              {TYPE_LABEL[s.type]}
            </Text>
          ) : (
            <Text dimColor>   ← back to you</Text>
          )}
        </Text>
      ))}
      <Text dimColor>{start + maxVisible < chain.length ? "     ▼ more" : " "}</Text>
    </Box>
  )
}

// ── Flows: ranked adjacency ledger ───────────────────────────────────────────

function Flows({
  graph,
  node,
  rows,
  offset,
  setOffset,
}: {
  graph: HandoffGraph
  node: (id: string) => HandoffNode
  rows: number
  offset: number
  setOffset: (fn: (o: number) => number) => void
}) {
  const srcW = Math.max(...graph.edges.map((e) => stringWidth(seatLabel(node(e.source)))))
  const dstW = Math.max(...graph.edges.map((e) => stringWidth(seatLabel(node(e.target)))))
  const maxCount = Math.max(...graph.edges.map((e) => e.count))
  const BAR = 12
  const countW = Math.max(...graph.edges.map((e) => String(e.count).length))

  const maxVisible = Math.max(3, Math.min(graph.edges.length, rows - 9))
  const maxOffset = Math.max(0, graph.edges.length - maxVisible)
  const start = Math.min(offset, maxOffset)
  if (offset > maxOffset) setOffset(() => maxOffset)
  const windowed = graph.edges.slice(start, start + maxVisible)

  return (
    <Box flexDirection="column">
      <Text dimColor>{start > 0 ? "  ▲ more" : " "}</Text>
      {windowed.map((e) => {
        const type = dominantType(e)
        const bars = Math.max(1, Math.round((e.count / maxCount) * BAR))
        return (
          <Text key={`${e.source}>${e.target}`}>
            <Text color={node(e.source).color}>{pad(seatLabel(node(e.source)), srcW)}</Text>
            <Text dimColor> → </Text>
            <Text color={node(e.target).color}>{pad(seatLabel(node(e.target)), dstW)}</Text>
            <Text dimColor>  ×{padStart(String(e.count), countW)} </Text>
            <Text color={TYPE_COLOR[type]}>{"█".repeat(bars)}</Text>
            {" ".repeat(BAR - bars + 1)}
            <Text color={TYPE_COLOR[type]} dimColor>
              {TYPE_LABEL[type]}
            </Text>
          </Text>
        )
      })}
      <Text dimColor>{start + maxVisible < graph.edges.length ? "  ▼ more" : " "}</Text>
    </Box>
  )
}
