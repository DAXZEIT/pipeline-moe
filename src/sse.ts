// Minimal Server-Sent Events hub. One process-wide hub; every connected client
// receives every event. Payloads are small and JSON-serialisable.

import type { Response } from "express"

export type SseEventName =
  | "roster" // full roster snapshot
  | "message" // a completed transcript line (user or agent)
  | "token" // a streaming text delta from an agent
  | "activity" // a tool-call start/end from an agent (live process visibility)
  | "reasoning" // a streaming thinking delta from an agent (ephemeral)
  | "status" // a participant status change
  | "receipt" // a work receipt (filesystem diff)
  | "notice" // an informational/error notice
  | "turn" // a routing turn lifecycle marker (phases: start, end, chain, parallel, pause, resume)
  | "workspace" // live workspace file listing
  | "settings" // room settings change (e.g. chaining toggle)
  | "routing" // semi/manual routing: a handoff proposal awaiting approval, or its resolution
  | "transcript" // full transcript replacement (on conversation switch)
  | "conversations" // saved-conversation list + current id
  | "providers" // provider auth status changed (after add/remove)
  | "oauth_progress" // OAuth login progress (device code, success, error)
  | "room" // room lifecycle event (created, destroyed)
  | "tasks" // shared task board snapshot (after any task_* tool mutation)

export const DEFAULT_SSE_MAX_CLIENTS = 10

/** Interval between SSE comment heartbeats (`: ping`). Proxies and load
 *  balancers often drop connections that go silent for tens of seconds —
 *  a comment frame keeps the stream warm without emitting any event the
 *  clients dispatch on (both the browser EventSource and the `eventsource`
 *  npm package ignore comment lines per the SSE spec, like the existing
 *  `: connected` frame). */
export const DEFAULT_SSE_HEARTBEAT_INTERVAL_MS = 25_000

export class SseHub {
  /**
   * Map from Response to this client's subscription state.
   * roomId: undefined = global subscriber (receives all events),
   *         string    = room-filtered subscriber (matching room + global events).
   * heartbeat: timer writing periodic `: ping` comments until the connection
   *            closes.
   */
  private clients = new Map<Response, { roomId: string | undefined; heartbeat: ReturnType<typeof setInterval> }>()

  constructor(
    readonly maxClients: number = DEFAULT_SSE_MAX_CLIENTS,
    readonly heartbeatIntervalMs: number = DEFAULT_SSE_HEARTBEAT_INTERVAL_MS,
  ) {}

  /**
   * Register a new SSE client.
   * @param res  Express response to write events to.
   * @param roomId  Optional room filter. If set, this client only receives events
   *                tagged with matching roomId, plus events with no roomId tag (global).
   */
  addClient(res: Response, roomId?: string): void {
    if (this.clients.size >= this.maxClients) {
      res.writeHead(429, "Too Many SSE Connections")
      res.end()
      return
    }
    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache, no-transform")
    res.setHeader("Connection", "keep-alive")
    res.setHeader("X-Accel-Buffering", "no")
    res.flushHeaders?.()
    res.write(`: connected\n\n`)
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping\n\n`)
      } catch {
        this.removeClient(res)
      }
    }, this.heartbeatIntervalMs)
    heartbeat.unref?.() // never keep the process alive on its own
    this.clients.set(res, { roomId, heartbeat })
    res.on("close", () => this.removeClient(res))
  }

  /** Drop a client: clear its heartbeat timer and forget it. */
  private removeClient(res: Response): void {
    const client = this.clients.get(res)
    if (!client) return
    clearInterval(client.heartbeat)
    this.clients.delete(res)
  }

  /**
   * Broadcast an event to subscribers.
   * @param roomId  Optional originating room. If set, only clients subscribed to
   *                that room (or global, unfiltered clients) receive it. If omitted,
   *                the event reaches everyone — used for process-global events like
   *                room lifecycle (created/destroyed/renamed).
   */
  broadcast(event: SseEventName, data: unknown, roomId?: string): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const [res, client] of this.clients) {
      // Skip if this client has a room filter AND the event targets a different room.
      // Events with no roomId (global lifecycle events) reach everyone.
      if (client.roomId !== undefined && roomId !== undefined && client.roomId !== roomId) {
        continue
      }
      try {
        res.write(frame)
      } catch {
        this.removeClient(res)
      }
    }
  }

  get clientCount(): number {
    return this.clients.size
  }
}
