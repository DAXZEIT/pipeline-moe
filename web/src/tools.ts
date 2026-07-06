// Every tool the server's parsePersona accepts (src/validation.ts VALID_TOOLS).
// Single source for the chip rows so Create and Edit can't drift apart.
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
]
