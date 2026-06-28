// Domain types now live in the shared, framework-agnostic client package so the
// web frontend and a future terminal client share one definition. This file is
// a re-export shim: every component still imports from "../types".
export * from "@pipeline-moe/client-core"
