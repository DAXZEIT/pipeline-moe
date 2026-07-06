# @pipeline-moe/client-core

Framework-agnostic client library for a
[pipeline-moe](https://github.com/DAXZEIT/pipeline-moe) server — the shared
core behind both official clients (the
[`pmoe` TUI](https://www.npmjs.com/package/@pipeline-moe/tui) and the bundled
web UI).

## What's inside

- **Typed REST surface** — `createApi(apiBase)` wraps every server endpoint
  (rooms, messages, lineup, presets, providers) with typed requests/responses.
- **Pure SSE reducer** — `reduce(state, event) -> { state, effects }` turns the
  server's event stream into room state deterministically; trivially unit
  testable.
- **Effectful room store** — `createRoomStore` binds the reducer to a live
  `EventSource`, with subscribe/notify semantics that plug straight into
  `useSyncExternalStore` (web) or any render loop (TUI).
- **Injectable `EventSourceFactory`** — the browser uses the global
  `EventSource`; Node clients inject one (e.g. the
  [`eventsource`](https://www.npmjs.com/package/eventsource) package).

Ships as plain ESM with type declarations — no framework, no build-tool
assumptions.

## Install

```bash
npm i @pipeline-moe/client-core
```

## Usage sketch

```ts
import { createRoomStore } from "@pipeline-moe/client-core"

const store = createRoomStore({
  apiBase: "http://localhost:5300",
  roomId: "default",
  // In the browser, omit eventSourceFactory (global EventSource is used).
  // In Node, inject one built on the `eventsource` package:
  eventSourceFactory: nodeEventSourceFactory,
})

const unsubscribe = store.subscribe(() => {
  const state = store.getSnapshot() // roster, transcript, streaming buffers…
})
store.start() // loads the snapshot and opens the SSE stream
```

A Node factory is ~10 lines over the `EventSourceFactory` seam — see
[`packages/tui/src/nodeEventSource.ts`](https://github.com/DAXZEIT/pipeline-moe/blob/main/packages/tui/src/nodeEventSource.ts)
for the reference implementation.

## License

MIT — see the [repository](https://github.com/DAXZEIT/pipeline-moe).
