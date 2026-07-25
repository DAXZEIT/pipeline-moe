import { toSegments, summarizeArgs, TOOL_ICON } from "@pipeline-moe/client-core"
import type { ActivityGroup, DisplaySegment, ToolActivity, TurnPart } from "../types"

// Block 5 of docs/interleaved-turns.md — the web counterpart of the TUI's
// chronological turn. Same segments, same order, same aggregation (all of it
// from client-core); only the drawing is DOM instead of ANSI.
//
// The web has two things the terminal does not: unbounded scroll and a real
// disclosure widget. So there is no sequence windowing here — a long turn is
// long, and the user scrolls. Each unit collapses on its own instead.

function ToolItem({ a }: { a: ToolActivity }) {
  const args = summarizeArgs(a)
  return (
    <div className={`activity-item status-${a.status}`}>
      <div className="activity-line">
        <span className="activity-tool">
          <span className="activity-icon">{TOOL_ICON[a.toolName] ?? "🔧"}</span>
          {a.toolName}
        </span>
        <code className="activity-args">{args}</code>
        <span className={`activity-badge badge-${a.status}`}>
          {a.status === "running" ? "…" : a.status === "error" ? "err" : "ok"}
        </span>
      </div>
      {a.result ? (
        <details className="activity-result">
          <summary>result</summary>
          <pre>{a.result}</pre>
        </details>
      ) : null}
    </div>
  )
}

/** A run of consecutive same-tool calls. One call renders as itself; a ×N
 *  burst collapses to a single summary row (the TUI's "📖 read ×6 a.md, b.md")
 *  that opens into the individual calls — the disclosure the terminal gets
 *  from ctrl+o. */
function ToolGroup({ group }: { group: ActivityGroup }) {
  if (group.items.length === 1) return <ToolItem a={group.items[0]} />
  const args = group.items.map(summarizeArgs).filter(Boolean).join(", ")
  return (
    <details className={`activity-group status-${group.status}`}>
      <summary className="activity-line">
        <span className="activity-tool">
          <span className="activity-icon">{TOOL_ICON[group.toolName] ?? "🔧"}</span>
          {group.toolName} ×{group.items.length}
        </span>
        <code className="activity-args">{args}</code>
        <span className={`activity-badge badge-${group.status}`}>
          {group.status === "running" ? "…" : group.status === "error" ? "err" : "ok"}
        </span>
      </summary>
      <div className="activity-list">
        {group.items.map((a) => (
          <ToolItem key={a.toolCallId} a={a} />
        ))}
      </div>
    </details>
  )
}

/** One thought. Collapsed by default once the turn is done; the segment in
 *  flight opens itself so the user can watch it move. */
function Thought({ content, live }: { content: string; live: boolean }) {
  return (
    <details className={live ? "reasoning-live" : "reasoning-done"} open={live}>
      <summary>{live ? "💭 thinking…" : "💭 thought"}</summary>
      <pre>{content}</pre>
    </details>
  )
}

interface Props {
  parts: TurnPart[]
  activity: ToolActivity[] | undefined
  /** The turn is still running: its LAST segment — and only that one — is in
   *  flight. Marking them all live would re-open every thought the turn had. */
  live?: boolean
  /** Border color of the prose bubble (the author's). */
  color: string
}

export function SequenceView({ parts, activity, live, color }: Props) {
  const segments = toSegments(parts, activity)
  if (segments.length === 0) return null
  const inFlight = segments[segments.length - 1]
  return (
    <>
      {segments.map((s, i) => (
        <Segment key={i} s={s} live={!!live && s === inFlight} color={color} />
      ))}
    </>
  )
}

function Segment({ s, live, color }: { s: DisplaySegment; live: boolean; color: string }) {
  if (s.kind === "tools") return <ToolGroup group={s.group} />
  if (s.kind === "reasoning") return <Thought content={s.content} live={live} />
  return (
    <div className={`bubble bubble-agent${live ? " streaming" : ""}`} style={{ borderColor: color }}>
      {s.content}
      {live && <span className="caret" />}
    </div>
  )
}

/** Whether a turn's prose was already drawn in place, as text segments.
 *  `message.text` is then a COMPOSED body (the reply plus whatever the server
 *  appended) and re-rendering it would duplicate the reply — the one case it
 *  must still be drawn is a turn that wrote no prose at all, where the body IS
 *  the placeholder. */
export function proseDrawn(parts: TurnPart[] | undefined): boolean {
  return !!parts?.some((p) => p.type === "text")
}
