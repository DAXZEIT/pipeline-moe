// Every tool the server's parsePersona accepts (src/validation.ts VALID_TOOLS).
// Single source for the chip rows so Create and Edit can't drift apart.
// Orchestration tools are gated at runtime by ctx.orchestrator/ctx.parentLink
// (buildCustomTools), not by this list — assigning them here just makes them
// grantable to any persona through the chip UI, same as via the API.
export const ALL_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "web_search",
  "web_read",
  "youtube_transcript",
  "arxiv_search",
  "youcom_search",
  "spawn_room",
  "check_room",
  "stop_room",
  "destroy_room",
  "answer_room",
]
