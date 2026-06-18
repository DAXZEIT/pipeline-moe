// youtube_transcript — YouTube transcript tool definition
// Fetches timestamped transcripts from YouTube videos.
// Uses youtube-transcript-plus package.

import { Type } from "typebox"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { AgentToolResult } from "@earendil-works/pi-coding-agent"
import { YoutubeTranscript } from "youtube-transcript-plus"

// Minimal text content type (mirrors pi-ai TextContent — not re-exported).
interface TextContent {
  type: "text"
  text: string
}

const youtubeTranscriptSchema = Type.Object({
  video: Type.String({
    description: "YouTube video ID (11 chars) or full URL (youtube.com/watch?v=... or youtu.be/...)",
  }),
})

const MAX_CONTENT_LENGTH = 8000

// Extract video ID from various YouTube URL formats.
function extractVideoId(input: string): string {
  // Already a bare ID (11 chars, alphanumeric + _ -)
  if (/^[a-zA-Z0-9_-]{11}$/.test(input.trim())) {
    return input.trim()
  }

  // youtube.com/watch?v=VIDEO_ID
  const watchMatch = input.match(/[?&]v=([a-zA-Z0-9_-]{11})/)
  if (watchMatch) return watchMatch[1]

  // youtu.be/VIDEO_ID
  const shortMatch = input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/)
  if (shortMatch) return shortMatch[1]

  // youtube.com/embed/VIDEO_ID
  const embedMatch = input.match(/embed\/([a-zA-Z0-9_-]{11})/)
  if (embedMatch) return embedMatch[1]

  throw new Error(`Could not extract video ID from: ${input}`)
}

// Format seconds as MM:SS.
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, "0")}`
}

async function fetchTranscript(videoInput: string): Promise<AgentToolResult<undefined>> {
  let videoId: string
  try {
    videoId = extractVideoId(videoInput)
  } catch (err) {
    return {
      content: [{
        type: "text",
        text: `youtube_transcript error: ${(err as Error).message}.`,
      }],
      details: undefined,
    }
  }

  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId)

    if (!segments || segments.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No transcript available for video ${videoId}. The video may not have captions or they may be disabled.`,
        }],
        details: undefined,
      }
    }

    // Format as timestamped text.
    const lines = segments.map((seg) => {
      const time = formatTime(seg.offset)
      return `[${time}] ${seg.text}`
    })

    const content = lines.join("\n")

    // Truncate to avoid context explosion.
    const text = content.length > MAX_CONTENT_LENGTH
      ? content.slice(0, MAX_CONTENT_LENGTH) + "\n\n[transcript truncated — " + content.length + " chars total]"
      : content

    return {
      content: [{ type: "text", text }],
      details: undefined,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{
        type: "text",
        text: `youtube_transcript error: ${msg}.`,
      }],
      details: undefined,
    }
  }
}

export function createYoutubeTranscriptToolDefinition(): ToolDefinition<typeof youtubeTranscriptSchema, undefined> {
  return {
    name: "youtube_transcript",
    label: "YouTube Transcript",
    description:
      "Fetch timestamped transcript from a YouTube video. " +
      "Accepts video ID (11 chars) or full URL (youtube.com/watch?v=... or youtu.be/...). " +
      "Returns text formatted as [MM:SS] text. " +
      "Truncated to ~8000 chars to avoid context explosion.",
    parameters: youtubeTranscriptSchema,
    execute: async (_toolCallId, params) => {
      const video = params.video
      return fetchTranscript(video)
    },
  }
}
