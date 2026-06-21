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

// ── Room-filtered clients ─────────────────────────────────────────────────────────

function makeMockRes() {
  const writes: string[] = []
  const res = {
    setHeader: () => {},
    flushHeaders: () => {},
    write: (data: string) => { if (typeof data === "string" && data.includes("event:")) writes.push(data) },
    on: () => {},
  } as unknown as Response
  return { res, writes }
}

test("global subscriber receives all events regardless of roomId", () => {
  const hub = new SseHub()
  const { res, writes } = makeMockRes()
  hub.addClient(res) // no roomId — global

  hub.broadcast("message", { roomId: "room-a", text: "hello" })
  hub.broadcast("message", { roomId: "room-b", text: "world" })

  expect(writes).toHaveLength(2)
})

test("room-filtered subscriber only receives matching roomId events", () => {
  const hub = new SseHub()
  const { res, writes } = makeMockRes()
  hub.addClient(res, "room-a") // filter to room-a

  hub.broadcast("message", { roomId: "room-a", text: "for room-a" })
  hub.broadcast("message", { roomId: "room-b", text: "for room-b" })

  expect(writes).toHaveLength(1)
  expect(writes[0]).toContain("for room-a")
})

test("room-filtered subscriber receives events with no roomId (global events)", () => {
  const hub = new SseHub()
  const { res, writes } = makeMockRes()
  hub.addClient(res, "room-a")

  // Event with no roomId (e.g. providers, oauth_progress)
  hub.broadcast("providers", { providers: [] })
  // Event for a different room — should be filtered out
  hub.broadcast("message", { roomId: "room-b", text: "other room" })
  // Event for this room — should arrive
  hub.broadcast("turn", { roomId: "room-a", phase: "end" })

  expect(writes).toHaveLength(2) // providers + room-a turn
  expect(writes[0]).toContain("providers")
  expect(writes[1]).toContain("turn")
})

test("multiple room-filtered subscribers are isolated from each other", () => {
  const hub = new SseHub()
  const { res: resA, writes: writesA } = makeMockRes()
  const { res: resB, writes: writesB } = makeMockRes()
  hub.addClient(resA, "room-a")
  hub.addClient(resB, "room-b")

  hub.broadcast("status", { roomId: "room-a", id: "planner", status: "idle" })
  hub.broadcast("status", { roomId: "room-b", id: "builder", status: "working" })

  expect(writesA).toHaveLength(1)
  expect(writesA[0]).toContain("planner")
  expect(writesB).toHaveLength(1)
  expect(writesB[0]).toContain("builder")
})

test("global and room-filtered subscribers coexist", () => {
  const hub = new SseHub()
  const { res: globalRes, writes: globalWrites } = makeMockRes()
  const { res: roomRes, writes: roomWrites } = makeMockRes()
  hub.addClient(globalRes)           // global
  hub.addClient(roomRes, "room-a")   // room-filtered

  hub.broadcast("message", { roomId: "room-a", text: "A" })
  hub.broadcast("message", { roomId: "room-b", text: "B" })

  // Global subscriber gets both
  expect(globalWrites).toHaveLength(2)
  // Room-a subscriber gets only room-a
  expect(roomWrites).toHaveLength(1)
  expect(roomWrites[0]).toContain("\"A\"")
})

test("room lifecycle event is broadcast as 'room' SSE event type", () => {
  const hub = new SseHub()
  const { res, writes } = makeMockRes()
  hub.addClient(res)

  hub.broadcast("room", { type: "created", roomId: "cloud-sprint", name: "Cloud Sprint" })

  expect(writes).toHaveLength(1)
  expect(writes[0]).toContain("event: room")
  expect(writes[0]).toContain("created")
  expect(writes[0]).toContain("cloud-sprint")
})
