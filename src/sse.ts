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
  | "turn" // a routing turn lifecycle marker
  | "workspace" // live workspace file listing
  | "settings" // room settings change (e.g. chaining toggle)
  | "transcript" // full transcript replacement (on conversation switch)
  | "conversations" // saved-conversation list + current id

export class SseHub {
  private clients = new Set<Response>()

  addClient(res: Response): void {
    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache, no-transform")
    res.setHeader("Connection", "keep-alive")
    res.setHeader("X-Accel-Buffering", "no")
    res.flushHeaders?.()
    res.write(`: connected\n\n`)
    this.clients.add(res)
    res.on("close", () => this.clients.delete(res))
  }

  broadcast(event: SseEventName, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of this.clients) {
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
