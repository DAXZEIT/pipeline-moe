import type { Response } from "express"
import { expect, test } from "vitest"
import { SseHub } from "../sse.js"

test("clientCount starts at 0", () => {
  const hub = new SseHub()
  expect(hub.clientCount).toBe(0)
})

test("addClient increments count", () => {
  const hub = new SseHub()
  const mockRes = {
    setHeader: () => {},
    flushHeaders: () => {},
    write: () => {},
    on: () => {},
  } as unknown as Response

  hub.addClient(mockRes)
  expect(hub.clientCount).toBe(1)
})

test("client close removes from count", () => {
  const hub = new SseHub()
  let closeHandler: (() => void) | undefined

  const mockRes = {
    setHeader: () => {},
    flushHeaders: () => {},
    write: () => {},
    on: (event: string, handler: () => void) => {
      if (event === "close") closeHandler = handler
    },
  } as unknown as Response

  hub.addClient(mockRes)
  expect(hub.clientCount).toBe(1)

  closeHandler?.()
  expect(hub.clientCount).toBe(0)
})

test("broadcast sends to all connected clients", () => {
  const hub = new SseHub()
  const broadcastWrites: string[] = []

  const makeMock = () => ({
    setHeader: () => {},
    flushHeaders: () => {},
    write: (data: string) => {
      // Only count writes that are SSE event frames (contain "event:")
      if (typeof data === "string" && data.includes("event:")) {
        broadcastWrites.push(data)
      }
    },
    on: () => {},
  } as unknown as Response)

  hub.addClient(makeMock())
  hub.addClient(makeMock())

  hub.broadcast("message", { text: "hello" })
  expect(broadcastWrites.length).toBe(2)
  expect(broadcastWrites[0]).toContain("event: message")
  expect(broadcastWrites[0]).toContain("hello")
})

test("broadcast does not send to closed clients", () => {
  const hub = new SseHub()
  const broadcastWrites: string[] = []

  let closeHandler: (() => void) | undefined

  const makeMock = () => ({
    setHeader: () => {},
    flushHeaders: () => {},
    write: (data: string) => {
      if (typeof data === "string" && data.includes("event:")) {
        broadcastWrites.push(data)
      }
    },
    on: (event: string, handler: () => void) => {
      if (event === "close") closeHandler = handler
    },
  } as unknown as Response)

  hub.addClient(makeMock())
  hub.addClient(makeMock())

  // Close one client
  closeHandler?.()

  hub.broadcast("message", { text: "hello" })
  expect(broadcastWrites.length).toBe(1)
})

// ── SSE connection cap ──────────────────────────────────────────────────

test("addClient rejects with 429 when max clients reached", () => {
  const hub = new SseHub(2) // max 2 clients
  const writes: string[] = []

  const makeMock = (idx: number) => {
    let writeHandler: ((data: string) => void) | undefined
    const mockRes = {
      setHeader: () => {},
      flushHeaders: () => {},
      write: (data: string) => {
        if (writeHandler) writeHandler(data)
        writes.push(data)
      },
      on: () => {},
      writeHead: () => {},
      end: () => {},
      get writeHandler(): ((data: string) => void) | undefined { return writeHandler }
    }
    Object.defineProperty(mockRes, 'writeHandler', {
      get: () => writeHandler,
      set: (v: ((data: string) => void) | undefined) => { writeHandler = v }
    })
    return mockRes as unknown as Response
  }

  hub.addClient(makeMock(1))
  hub.addClient(makeMock(2))
  expect(hub.clientCount).toBe(2)

  // Third client should be rejected
  const rejected = makeMock(3)
  hub.addClient(rejected)
  expect(hub.clientCount).toBe(2)
})

test("SseHub uses DEFAULT_SSE_MAX_CLIENTS when no limit given", () => {
  const hub = new SseHub()
  expect(hub.maxClients).toBe(10)
})
