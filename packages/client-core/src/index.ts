// @pipeline-moe/client-core — framework-agnostic client for a pipeline-moe
// server: the typed REST surface, the shared domain types, the pure SSE
// reducer, and the effectful room store. Both the web frontend and a terminal
// client consume this one protocol implementation.

export * from "./types.js"
export { createApi } from "./api.js"
export type { ClientApi, RoomApi, Api } from "./api.js"

export { previewRouting } from "./mentions.js"
export type { RoutingPreview } from "./mentions.js"

export {
  initialRoomState,
  resetTransient,
  reduce,
  SSE_EVENT_NAMES,
} from "./state.js"
export type {
  RoomState,
  Notice,
  ThinkingLevel,
  SseEvent,
  SseEventName,
  Effect,
  ReduceResult,
} from "./state.js"

export { createRoomStore, browserEventSourceFactory } from "./store.js"
export type {
  RoomStore,
  RoomStoreOptions,
  EventSourceFactory,
  SseConnection,
  SseHandlers,
} from "./store.js"
