import { stat, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve } from "node:path"

/** Client-side cap before base64-encoding into a JSON message body — keeps
 *  a mistaken huge path (a raw photo, a video renamed .png) from blocking
 *  the command line or blowing up the SSE payload. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10MB

/** Extension → mime subtype, matching the server's saveImage() regex
 *  (src/server.ts) exactly: png|jpeg|webp|gif. Note "jpeg", not "jpg" —
 *  both extensions map to the same mime subtype so the server accepts them. */
const IMAGE_EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
}

export type ImageAttachResult = { ok: true; dataUri: string } | { ok: false; error: string }

/** "~/foo" -> "/home/user/foo". Leaves absolute and relative paths untouched. */
export function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2))
  return path
}

/** Read a local image file and encode it as the "data:image/…;base64,…" URI
 *  the server's saveImage() expects. Validates extension, existence, and
 *  size before reading — a clear notice beats a silent failed send. */
export async function loadImageAttachment(rawPath: string): Promise<ImageAttachResult> {
  const path = expandHome(rawPath.trim())
  if (!path) return { ok: false, error: "Usage: /image <path>" }

  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  const mime = IMAGE_EXT_MIME[ext]
  if (!mime) return { ok: false, error: `Unsupported image type ".${ext}" — use png, jpg, jpeg, webp, or gif.` }

  let st
  try {
    st = await stat(path)
  } catch {
    return { ok: false, error: `File not found: ${path}` }
  }
  if (!st.isFile()) return { ok: false, error: `Not a file: ${path}` }
  if (st.size > MAX_IMAGE_BYTES) {
    return { ok: false, error: `Image too large (${(st.size / (1024 * 1024)).toFixed(1)}MB, max 10MB): ${path}` }
  }

  const buf = await readFile(path)
  return { ok: true, dataUri: `data:${mime};base64,${buf.toString("base64")}` }
}
