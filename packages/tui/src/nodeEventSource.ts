// Node EventSource factory. The store is host-neutral and asks for SSE through
// the EventSourceFactory seam; the browser plugs in its global EventSource, and
// here we plug in the `eventsource` npm package (Node has no global EventSource
// even on v26). This is the only host-specific code the terminal client needs.

import { EventSource } from "eventsource"
import { SSE_EVENT_NAMES, type EventSourceFactory } from "@pipeline-moe/client-core"

export const nodeEventSourceFactory: EventSourceFactory = (url, h) => {
  const es = new EventSource(url)
  es.onopen = () => h.onOpen()
  es.onerror = () => h.onError()
  for (const name of SSE_EVENT_NAMES) {
    es.addEventListener(name, (e) => h.onEvent(name, e.data))
  }
  return { close: () => es.close() }
}
