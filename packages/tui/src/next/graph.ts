// `/graph` — the room's handoffs, on pi-tui.
//
// This is the cleanest port in the migration, and for a reason worth naming: the
// Ink version already computed nothing. `deriveHandoffGraph` and
// `deriveHandoffChain` live in client-core (the web graph reads the same two
// functions), so `GraphOverlay.tsx` was 223 lines of PADDING AND COLOUR around
// two pure derivations. Take away the JSX and what is left is string generation,
// which is what this file is.
//
// The one thing that changes: alignment is measured with pi-tui's ruler rather
// than `string-width`. This screen is where that matters most — every row starts
// with an agent's emoji, and a seat whose icon the two rulers disagree about
// would knock its whole column out of line. Same reason `overlay-frame.ts`
// settled on one measure in Phase 4.

import chalk from "chalk"
import { matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui"
import {
  deriveHandoffChain,
  deriveHandoffGraph,
  dominantType,
  USER_NODE,
  type HandoffChainStep,
  type HandoffEdge,
  type HandoffGraph,
  type HandoffNode,
  type HandoffType,
  type Message,
  type RosterItem,
} from "@pipeline-moe/client-core"
import { fitLine, frame, moreMarker, twoColumn, visible } from "./overlay-frame"
import type { Rows } from "./overlays"

/** chalk colour per transition type — the same three the web graph tints its
 *  edges with, so a route looks like a route in both clients. */
const TYPE_COLOR: Record<HandoffType, "gray" | "cyan" | "green"> = {
  handoff: "gray",
  route: "cyan",
  hatswitch: "green",
}
const TYPE_LABEL: Record<HandoffType, string> = {
  handoff: "handoff",
  route: "route",
  hatswitch: "hat-switch",
}

const seatLabel = (n: HandoffNode | HandoffChainStep): string =>
  `${n.icon} ${n.id === USER_NODE ? "you" : n.name}`

/** Pad to `width` COLUMNS as the terminal draws them — not as `string-width`
 *  counts them. See the module comment. */
function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visible(s)))
}
function padStart(s: string, width: number): string {
  return " ".repeat(Math.max(0, width - visible(s))) + s
}

/** How many data rows fit: the frame's three chrome rows, the counts row, a
 *  blank, and the two `more` markers, plus room to still see the conversation
 *  behind the overlay. */
function graphRows(rows: number, total: number): number {
  return Math.max(3, Math.min(total, rows - 12))
}

export interface GraphOverlayOptions {
  /** Read live: the graph redraws itself as the turn walks the roster, which is
   *  half the reason to have it open during a run. */
  messages: () => Message[]
  roster: () => RosterItem[]
  onClose: () => void
  /** Which read opens first; `t`/`f` switch freely after. */
  initialView?: "flows" | "trace"
}

export class GraphOverlayComponent implements Component, Focusable {
  focused = false
  private view: "flows" | "trace"
  private offset = 0
  // Both derivations walk the whole transcript. The Ink version leaned on
  // `useMemo`; here the memo is explicit, keyed on the ARRAY IDENTITY the store
  // hands out — a finalized transcript keeps the same array across frames, so a
  // long room derives once and re-renders for free.
  private memo: { messages: Message[]; roster: RosterItem[]; graph: HandoffGraph; chain: HandoffChainStep[] } | null =
    null

  constructor(
    private opts: GraphOverlayOptions,
    private rows: Rows = () => process.stdout.rows ?? 24,
  ) {
    this.view = opts.initialView ?? "trace"
  }

  invalidate(): void {}

  private derived(): { graph: HandoffGraph; chain: HandoffChainStep[] } {
    const messages = this.opts.messages()
    const roster = this.opts.roster()
    if (this.memo && this.memo.messages === messages && this.memo.roster === roster) return this.memo
    const graph = deriveHandoffGraph(messages, roster)
    const chain = deriveHandoffChain(messages, roster)
    this.memo = { messages, roster, graph, chain }
    return this.memo
  }

  /** Rows the current view has to show, which is what bounds the scroll. */
  private count(): number {
    const { graph, chain } = this.derived()
    return this.view === "trace" ? chain.length : graph.edges.length
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") return this.opts.onClose()
    // Switching view resets the scroll: the two reads have different lengths and
    // carrying an offset across lands you in the middle of a list you did not
    // scroll. (The Ink version kept one offset for both, and did land there.)
    if (data === "t") {
      if (this.view !== "trace") this.offset = 0
      this.view = "trace"
      return
    }
    if (data === "f") {
      if (this.view !== "flows") this.offset = 0
      this.view = "flows"
      return
    }
    const total = this.count()
    const maxOffset = Math.max(0, total - graphRows(this.rows(), total))
    if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1)
    else if (matchesKey(data, "down")) this.offset = Math.min(maxOffset, this.offset + 1)
  }

  render(width: number): string[] {
    const { graph, chain } = this.derived()
    const inner = width - 4
    const total = this.count()
    const shown = graphRows(this.rows(), total)
    const start = Math.min(this.offset, Math.max(0, total - shown))

    const counts = chalk.dim(
      `${graph.total} handoff${graph.total === 1 ? "" : "s"} · ${graph.nodes.length} seat${graph.nodes.length === 1 ? "" : "s"}`,
    )
    const tab = (label: string, on: boolean): string => (on ? chalk.cyan.bold(label) : chalk.dim(label))
    const toggle = tab("[t]race", this.view === "trace") + chalk.dim(" / ") + tab("[f]lows", this.view === "flows")

    const body: string[] = [twoColumn(counts, toggle, inner), " "]
    if (graph.edges.length === 0) {
      body.push(chalk.dim("No handoffs yet — the graph draws itself as seats pass the turn."))
    } else {
      body.push(moreMarker(start > 0, "▲"))
      body.push(
        ...(this.view === "trace"
          ? traceRows(chain, start, shown, inner)
          : flowRows(graph, start, shown, inner)),
      )
      body.push(moreMarker(start + shown < total, "▼"))
    }

    return frame(
      {
        title: "HANDOFF GRAPH",
        ...(total > shown ? { titleRight: `${start + 1}-${Math.min(start + shown, total)}/${total}` } : {}),
        body,
        hint: "↑↓ scroll · t trace · f flows · esc close",
        color: "cyan",
      },
      width,
    )
  }
}

/* ── Trace: the turn's path, one numbered hop per line ─────────────────────────
 *
 * A 30-hop run is a wall of arrows read horizontally and a readable journal read
 * vertically, which is why this is a list and not the snake the web draws.
 */
export function traceRows(chain: HandoffChainStep[], start: number, count: number, inner: number): string[] {
  const idxW = String(chain.length).length
  const nameW = Math.max(0, ...chain.map((s) => visible(seatLabel(s))))
  return chain.slice(start, start + count).map((s, k) => {
    const i = start + k
    const n = chalk.dim(padStart(String(i + 1), idxW)) + "  "
    const arrow = i === 0 ? "  " : chalk[s.type ? TYPE_COLOR[s.type] : "gray"].bold("↳ ")
    const name = chalk.hex(s.color)(pad(seatLabel(s), nameW))
    const tail =
      i === 0
        ? chalk.dim("   start")
        : s.type
          ? chalk[TYPE_COLOR[s.type]].dim(`   ${TYPE_LABEL[s.type]}`)
          : chalk.dim("   ← back to you")
    return fitLine(n + arrow + name + tail, inner)
  })
}

/* ── Flows: the ranked adjacency ledger ─────────────────────────────────────── */

const BAR = 12

export function flowRows(graph: HandoffGraph, start: number, count: number, inner: number): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const node = (id: string): HandoffNode => byId.get(id) ?? { id, name: id, color: "#78716c", icon: "•", turns: 0 }
  const srcW = Math.max(0, ...graph.edges.map((e) => visible(seatLabel(node(e.source)))))
  const dstW = Math.max(0, ...graph.edges.map((e) => visible(seatLabel(node(e.target)))))
  const maxCount = Math.max(1, ...graph.edges.map((e) => e.count))
  const countW = Math.max(...graph.edges.map((e) => String(e.count).length))

  return graph.edges.slice(start, start + count).map((e: HandoffEdge) => {
    const type = dominantType(e)
    const bars = Math.max(1, Math.round((e.count / maxCount) * BAR))
    const src = chalk.hex(node(e.source).color)(pad(seatLabel(node(e.source)), srcW))
    const dst = chalk.hex(node(e.target).color)(pad(seatLabel(node(e.target)), dstW))
    return fitLine(
      src +
        chalk.dim(" → ") +
        dst +
        chalk.dim(`  ×${padStart(String(e.count), countW)} `) +
        chalk[TYPE_COLOR[type]]("█".repeat(bars)) +
        " ".repeat(BAR - bars + 1) +
        chalk[TYPE_COLOR[type]].dim(TYPE_LABEL[type]),
      inner,
    )
  })
}
