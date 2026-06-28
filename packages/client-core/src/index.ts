// @pipeline-moe/client-core — framework-agnostic client for a pipeline-moe
// server: the typed REST surface, the shared domain types, the pure SSE
// reducer, and the effectful room store. Both the web frontend and a terminal
// client consume this one protocol implementation.

export * from "./types"
export { createApi } from "./api"
export type { ClientApi, RoomApi, Api } from "./api"

export {
  initialRoomState,
  resetTransient,
  reduce,
  SSE_EVENT_NAMES,
} from "./state"
export type {
  RoomState,
  Notice,
  ThinkingLevel,
  SseEvent,
  SseEventName,
  Effect,
  ReduceResult,
} from "./state"

export { createRoomStore, browserEventSourceFactory } from "./store"
export type {
  RoomStore,
  RoomStoreOptions,
  EventSourceFactory,
  SseConnection,
  SseHandlers,
} from "./store"
