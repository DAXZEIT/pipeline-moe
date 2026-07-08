import { execFile } from "node:child_process"
import { promisify } from "node:util"

/** Test-only seam. Real subprocess mechanics (PATH resolution, buffer
 *  encoding, exit codes) aren't what this module's logic needs verifying —
 *  the mime selection / size threshold / error-mapping branches are. Real
 *  wl-paste/xclip also may not exist in CI. Tests substitute this instead
 *  of spawning processes; production code never touches it. */
type ExecFn = (
  file: string,
  args: string[],
  opts?: { encoding?: "buffer"; maxBuffer?: number },
) => Promise<{ stdout: string | Buffer }>

const realExec = promisify(execFile) as unknown as ExecFn
let exec: ExecFn = realExec

export function __setExecForTest(fn: ExecFn | null): void {
  exec = fn ?? realExec
}

/** Same cap as the /image command's file-based path — keeps a huge clipboard
 *  blob (an accidental full-res screenshot, a copied video frame) from
 *  blocking the command line or blowing up the SSE payload. */
export const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024

/** Matches the server's saveImage() regex (src/server.ts) exactly — png,
 *  jpeg, webp, gif. Ordered by preference when a clipboard offers more than
 *  one representation (screenshot tools often do). */
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"]

export type ClipboardImageResult =
  | { ok: true; dataUri: string }
  | { ok: false; reason: "no-image"; error?: undefined }
  | { ok: false; reason: "unavailable" | "too-large" | "error"; error: string }

type MimeListing = { tool: "wl-paste" | "xclip"; mimes: string[] } | null

/** List the mime types the clipboard currently offers. Tries Wayland's
 *  wl-paste first, falls back to X11's xclip — whichever is actually
 *  installed and has a live display to talk to. Neither present (or no
 *  display, e.g. an SSH session with no clipboard) → null, not a throw. */
async function listClipboardMimes(): Promise<MimeListing> {
  try {
    const { stdout } = await exec("wl-paste", ["--list-types"])
    return { tool: "wl-paste", mimes: String(stdout).split("\n").map((s) => s.trim()).filter(Boolean) }
  } catch {}
  try {
    const { stdout } = await exec("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"])
    return { tool: "xclip", mimes: String(stdout).split("\n").map((s) => s.trim()).filter(Boolean) }
  } catch {}
  return null
}

async function readClipboardBytes(tool: "wl-paste" | "xclip", mime: string): Promise<Buffer> {
  // Headroom above the cap so an oversized paste is *detected* as too-large
  // rather than silently truncated by execFile's own maxBuffer cutoff.
  const maxBuffer = MAX_CLIPBOARD_IMAGE_BYTES + 1024 * 1024
  const { stdout } =
    tool === "wl-paste"
      ? await exec("wl-paste", ["--type", mime], { encoding: "buffer", maxBuffer })
      : await exec("xclip", ["-selection", "clipboard", "-t", mime, "-o"], { encoding: "buffer", maxBuffer })
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
}

/** Read an image off the system clipboard as a "data:image/…;base64,…" URI
 *  — the same shape the /image command and the web UI's paste handler
 *  produce. `reason: "no-image"` means the clipboard has content but none
 *  of it is an image (plain text, a file-manager file reference, etc.) —
 *  the caller should fall back to a text paste, not show an error. */
export async function readClipboardImage(): Promise<ClipboardImageResult> {
  const listing = await listClipboardMimes()
  if (!listing) {
    return { ok: false, reason: "unavailable", error: "No clipboard tool found — install wl-clipboard (Wayland) or xclip (X11)." }
  }
  const mime = IMAGE_MIMES.find((m) => listing.mimes.includes(m))
  if (!mime) return { ok: false, reason: "no-image" }

  try {
    const buf = await readClipboardBytes(listing.tool, mime)
    if (buf.length > MAX_CLIPBOARD_IMAGE_BYTES) {
      return { ok: false, reason: "too-large", error: `Clipboard image too large (${(buf.length / (1024 * 1024)).toFixed(1)}MB, max 10MB).` }
    }
    if (buf.length === 0) return { ok: false, reason: "no-image" }
    return { ok: true, dataUri: `data:${mime};base64,${buf.toString("base64")}` }
  } catch (err) {
    return { ok: false, reason: "error", error: err instanceof Error ? err.message : String(err) }
  }
}

/** Read plain text off the clipboard — the fallback when Ctrl+V finds no
 *  image. wl-paste/xclip default to text/plain when no --type is given.
 *  --no-newline drops wl-paste's trailing newline (the composer is a
 *  single-line input; a stray \n would look like a paste bug). */
export async function readClipboardText(): Promise<{ ok: true; text: string } | { ok: false }> {
  try {
    const { stdout } = await exec("wl-paste", ["--no-newline"])
    return { ok: true, text: String(stdout) }
  } catch {}
  try {
    const { stdout } = await exec("xclip", ["-selection", "clipboard", "-o"])
    return { ok: true, text: String(stdout) }
  } catch {}
  return { ok: false }
}
