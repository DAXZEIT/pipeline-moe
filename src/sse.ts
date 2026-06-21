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
  | "circuit_breaker" // agent repeated similar output N times — pipeline aborted
  | "settings" // room settings change (e.g. chaining toggle)
  | "transcript" // full transcript replacement (on conversation switch)
  | "conversations" // saved-conversation list + current id
  | "providers" // provider auth status changed (after add/remove)
  | "oauth_progress" // OAuth login progress (device code, success, error)
  | "room" // room lifecycle event (created, destroyed)

export const DEFAULT_SSE_MAX_CLIENTS = 10

export class SseHub {
  /**
   * Map from Response to the roomId this client is subscribed to.
   * undefined = global subscriber (receives all events).
   * string    = room-filtered subscriber (receives events for that room + global events).
   */
  private clients = new Map<Response, string | undefined>()

  constructor(readonly maxClients: number = DEFAULT_SSE_MAX_CLIENTS) {}

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
    this.clients.set(res, roomId)
    res.on("close", () => this.clients.delete(res))
  }

  broadcast(event: SseEventName, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    // Extract roomId from payload if present (only objects carry it — not arrays or primitives).
    const dataRoomId: string | undefined =
      data !== null && typeof data === "object" && !Array.isArray(data)
        ? ((data as Record<string, unknown>).roomId as string | undefined)
        : undefined

    for (const [res, clientRoomId] of this.clients) {
      // Skip if this client has a room filter AND the event is for a different room.
      // Events with no roomId in the data (global events, array payloads) go to everyone.
      if (clientRoomId !== undefined && dataRoomId !== undefined && clientRoomId !== dataRoomId) {
        continue
      }
      try {
        res.write(frame)
      } catch {
        this.clients.delete(res)
      }
    }
  }

  get clientCount(): number {
    return this.clients.size
  }
}
