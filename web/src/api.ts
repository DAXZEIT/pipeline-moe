// The REST surface now lives in the shared, framework-agnostic client package.
// This file binds it to the web app's server origin and re-exports the same
// `{ API_BASE, makeRoomApi, api }` shape components already import from "../api".
import { createApi } from "@pipeline-moe/client-core"

// Server origin. Overridable at build time via VITE_API_BASE; defaults to the
// local backend.
const RESOLVED_API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:5300"

export const { API_BASE, makeRoomApi, api } = createApi(RESOLVED_API_BASE)
