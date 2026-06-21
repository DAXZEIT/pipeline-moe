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

// Filtering is driven by the explicit roomId *parameter* on broadcast(), not by
// inspecting the payload. Payloads here deliberately omit roomId to prove the
// param alone decides delivery — array payloads (roster) used to bypass the old
// payload-inspection filter entirely, which was the cross-room leak bug.

test("global subscriber receives all events regardless of roomId", () => {
  const hub = new SseHub()
  const { res, writes } = makeMockRes()
  hub.addClient(res) // no roomId — global

  hub.broadcast("message", { text: "hello" }, "room-a")
  hub.broadcast("message", { text: "world" }, "room-b")

  expect(writes).toHaveLength(2)
})

test("room-filtered subscriber only receives matching roomId events", () => {
  const hub = new SseHub()
  const { res, writes } = makeMockRes()
  hub.addClient(res, "room-a") // filter to room-a

  hub.broadcast("message", { text: "for room-a" }, "room-a")
  hub.broadcast("message", { text: "for room-b" }, "room-b")

  expect(writes).toHaveLength(1)
  expect(writes[0]).toContain("for room-a")
})

test("array payload (roster) is filtered by the roomId param, not bypassed", () => {
  // Regression: roster broadcasts are arrays. The old filter extracted roomId
  // from object payloads only, so arrays leaked to every room-filtered client,
  // clobbering one room's roster with another's. The explicit param fixes this.
  const hub = new SseHub()
  const { res, writes } = makeMockRes()
  hub.addClient(res, "room-a")

  hub.broadcast("roster", [{ id: "planner" }], "room-a") // arrives
  hub.broadcast("roster", [{ id: "builder" }], "room-b") // filtered out

  expect(writes).toHaveLength(1)
  expect(writes[0]).toContain("planner")
  expect(writes[0]).not.toContain("builder")
})

test("room-filtered subscriber receives events with no roomId (global events)", () => {
  const hub = new SseHub()
  const { res, writes } = makeMockRes()
  hub.addClient(res, "room-a")

  // Event with no roomId param (e.g. providers, oauth_progress, room lifecycle)
  hub.broadcast("providers", { providers: [] })
  // Event for a different room — should be filtered out
  hub.broadcast("message", { text: "other room" }, "room-b")
  // Event for this room — should arrive
  hub.broadcast("turn", { phase: "end" }, "room-a")

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

  hub.broadcast("status", { id: "planner", status: "idle" }, "room-a")
  hub.broadcast("status", { id: "builder", status: "working" }, "room-b")

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

  hub.broadcast("message", { text: "A" }, "room-a")
  hub.broadcast("message", { text: "B" }, "room-b")

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
