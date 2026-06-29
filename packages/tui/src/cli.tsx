#!/usr/bin/env -S npx tsx
// pmoe — pipeline-moe terminal client. Connects to a running server and renders
// one room. The whole client lives in @pipeline-moe/client-core; this entry just
// wires the Node SSE transport and mounts the Ink app.
//
//   pmoe [--server http://localhost:5300] [--room default]

import { render } from "ink"
import { createRoomStore, createApi } from "@pipeline-moe/client-core"
import { nodeEventSourceFactory } from "./nodeEventSource"
import { App } from "./App"

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const apiBase = arg("--server", process.env.PMOE_SERVER ?? "http://localhost:5300")
const roomId = arg("--room", "default")

const store = createRoomStore({ apiBase, roomId, eventSourceFactory: nodeEventSourceFactory })
const { api } = createApi(apiBase)

const { waitUntilExit } = render(<App store={store} api={api} />)
waitUntilExit().then(() => {
  store.stop()
  process.exit(0)
})
