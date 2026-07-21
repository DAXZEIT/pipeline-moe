// The handoff-graph derivation lives in the shared client-core package so the
// web frontend and the terminal client compute one identical graph. This file
// is a re-export shim: web components still import from "../handoffs".
export { deriveHandoffGraph, dominantType, USER_NODE } from "@pipeline-moe/client-core"
export type { HandoffGraph, HandoffNode, HandoffEdge, HandoffType } from "@pipeline-moe/client-core"
