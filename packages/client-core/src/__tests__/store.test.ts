import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoomStore, type EventSourceFactory, type SseHandlers } from "../store"

// A capturing EventSource factory: hands back the store's handlers so a test
// can drive SSE events synchronously, plus a spy on close().
function capturingFactory() {
  const handlers: { current: SseHandlers | null } = { current: null }
  const close = vi.fn()
  const factory: EventSourceFactory = (_url, h) => {
    handlers.current = h
    return { close }
  }
  return { factory, handlers, close }
}

function makeStore(noticeTtlMs = 1000) {
  const { factory, handlers, close } = capturingFactory()
  const store = createRoomStore({
    apiBase: "http://test",
    roomId: "default",
    eventSourceFactory: factory,
    noticeTtlMs,
  })
  return { store, handlers, close }
}

beforeEach(() => {
  // Snapshot REST calls are fire-and-forget with .catch swallows; reject them so
  // nothing hits the network and the store stays at its initial/SSE-driven state.
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("createRoomStore — SSE wiring", () => {
  it("routes a parsed SSE event through the reducer and notifies subscribers", () => {
    const { store, handlers } = makeStore()
    const notify = vi.fn()
    store.subscribe(notify)
    store.start()

    handlers.current!.onEvent("token", JSON.stringify({ id: "a", delta: "hi" }))

    expect(store.getSnapshot().streaming).toEqual({ a: "hi" })
    expect(notify).toHaveBeenCalled()
  })

  it("ignores malformed event payloads without throwing", () => {
    const { store, handlers } = makeStore()
    store.start()
    expect(() => handlers.current!.onEvent("token", "not json{")).not.toThrow()
    expect(store.getSnapshot().streaming).toEqual({})
  })

  it("toggles `connected` on open and error", () => {
    const { store, handlers } = makeStore()
    store.start()
    expect(store.getSnapshot().connected).toBe(false)
    handlers.current!.onOpen()
    expect(store.getSnapshot().connected).toBe(true)
    handlers.current!.onError()
    expect(store.getSnapshot().connected).toBe(false)
  })
})

describe("createRoomStore — notices", () => {
  it("surfaces a notice from a reducer effect and auto-dismisses it after the TTL", () => {
    vi.useFakeTimers()
    const { store, handlers } = makeStore(1000)
    store.start()

    handlers.current!.onEvent("notice", JSON.stringify({ msg: "hello", level: "info" }))
    expect(store.getSnapshot().notices).toHaveLength(1)
    expect(store.getSnapshot().notices[0]).toMatchObject({ msg: "hello", level: "info" })

    vi.advanceTimersByTime(1000)
    expect(store.getSnapshot().notices).toHaveLength(0)
  })

  it("assigns distinct ids and dismisses each notice independently", () => {
    vi.useFakeTimers()
    const { store, handlers } = makeStore(1000)
    store.start()

    handlers.current!.onEvent("notice", JSON.stringify({ msg: "first" }))
    vi.advanceTimersByTime(400)
    handlers.current!.onEvent("notice", JSON.stringify({ msg: "second" }))
    expect(store.getSnapshot().notices.map((n) => n.msg)).toEqual(["first", "second"])
    expect(store.getSnapshot().notices[0].id).not.toBe(store.getSnapshot().notices[1].id)

    vi.advanceTimersByTime(600) // first hits its 1000ms TTL, second has 400ms left
    expect(store.getSnapshot().notices.map((n) => n.msg)).toEqual(["second"])
    vi.advanceTimersByTime(400)
    expect(store.getSnapshot().notices).toHaveLength(0)
  })
})

describe("createRoomStore — lifecycle & actions", () => {
  it("stop() closes the SSE connection and cancels pending notice timers", () => {
    vi.useFakeTimers()
    const { store, handlers, close } = makeStore(1000)
    store.start()
    handlers.current!.onEvent("notice", JSON.stringify({ msg: "x" }))
    expect(store.getSnapshot().notices).toHaveLength(1)

    store.stop()
    expect(close).toHaveBeenCalledOnce()

    // Timer was cancelled, so the notice is not removed by an orphaned callback.
    vi.advanceTimersByTime(5000)
    expect(store.getSnapshot().notices).toHaveLength(1)
  })

  it("resolveRoute optimistically clears pendingRoute before the request resolves", () => {
    const { store, handlers } = makeStore()
    store.start()
    handlers.current!.onEvent(
      "routing",
      JSON.stringify({ type: "proposed", proposals: [{ from: "a", target: "b", targetName: "B" }] }),
    )
    expect(store.getSnapshot().pendingRoute).toHaveLength(1)

    store.actions.resolveRoute({ action: "approve" })
    expect(store.getSnapshot().pendingRoute).toBeNull()
  })
})

describe("initialState hydration + preloadRoomState", () => {
  it("a store created with initialState renders that state before start()", () => {
    const { factory } = capturingFactory()
    const roster = [
      { id: "pi", name: "pi", icon: "π", color: "cyan", active: true, parallel: false },
    ]
    const store = createRoomStore({
      apiBase: "http://test",
      roomId: "room-x",
      eventSourceFactory: factory,
      initialState: { roster: roster as never, routingMode: "manual" },
    })
    // No start(), no fetch — the first getSnapshot already carries the preload.
    expect(store.getSnapshot().roster).toHaveLength(1)
    expect(store.getSnapshot().routingMode).toBe("manual")
    // Untouched fields keep their initialRoomState defaults.
    expect(store.getSnapshot().messages).toEqual([])
    expect(store.getSnapshot().connected).toBe(false)
  })

  it("preloadRoomState maps roster/transcript/tasks/settings and tolerates individual failures", async () => {
    const { preloadRoomState } = await import("../store")
    const routes: Record<string, unknown> = {
      "/api/rooms/room-x/participants": [{ id: "a" }],
      "/api/rooms/room-x/transcript": [{ index: 0, authorId: "user", text: "hi" }],
      "/api/rooms/room-x/settings": { chaining: true, routingMode: "supervised", defaultAgent: "a" },
      // /tasks deliberately missing → that fetch rejects.
    }
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const path = new URL(url).pathname
        if (path in routes) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(routes[path]) })
        }
        return Promise.reject(new Error(`no route ${path}`))
      }),
    )
    const out = await preloadRoomState("http://test", "room-x")
    expect(out.roster).toEqual([{ id: "a" }])
    expect(out.messages).toHaveLength(1)
    expect(out.routingMode).toBe("supervised")
    expect(out.chaining).toBe(true)
    expect(out.tasks).toBeUndefined() // failed piece simply absent
  })
})
