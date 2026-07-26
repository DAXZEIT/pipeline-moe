/**
 * Handing a block of text to the user's $EDITOR and taking back what they saved.
 *
 * Extracted from `PromptOverlay.tsx` so both clients run one copy: multi-line
 * editing in a TUI input line is hopeless, the external editor is the
 * terminal-native answer (the `git commit` pattern), and the fiddly part is not
 * the spawn — it is the temp file, the "did anything change" comparison and the
 * empty-file guard, which are identical whichever renderer is on screen.
 *
 * What is NOT identical is how the terminal gets released, so that is the
 * caller's to pass in: Ink drops raw mode with `useStdin().setRawMode`, the
 * pi-tui client stops and restarts the TUI. `spawnSync` blocks the event loop —
 * neither renderer can repaint over the editor, which is exactly what we want:
 * the editor owns the tty through `stdio: "inherit"` until the user leaves it.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Pick the user's editor: $VISUAL, $EDITOR, then common fallbacks. */
export function resolveEditor(): string {
  if (process.env.VISUAL) return process.env.VISUAL
  if (process.env.EDITOR) return process.env.EDITOR
  for (const candidate of ["nvim", "vim", "nano", "vi"]) {
    const found = spawnSync("sh", ["-c", `command -v ${candidate}`], { stdio: "ignore" })
    if (found.status === 0) return candidate
  }
  return "vi"
}

export type EditOutcome =
  | { kind: "edited"; text: string }
  | { kind: "unchanged" }
  | { kind: "empty" }
  | { kind: "failed"; error: string }

export interface EditOptions {
  /** Temp file name — the extension is what gives the editor its syntax mode. */
  basename: string
  /** Release the terminal around the editor and take it back after. */
  suspend?: (run: () => void) => void
}

/**
 * Write `initial` to a temp file, open it in the editor, and classify what came
 * back. Four outcomes, because all four need different words on screen: a real
 * edit, no change, an emptied file (a mistake, never a save), and a failure.
 */
export function editText(initial: string, opts: EditOptions): EditOutcome {
  const suspend = opts.suspend ?? ((run: () => void): void => run())
  const dir = mkdtempSync(join(tmpdir(), "pmoe-edit-"))
  const file = join(dir, opts.basename)
  // A holder rather than a `let`: the assignment happens inside the callback, and
  // this keeps the type honest about that.
  const out: { res?: SpawnSyncReturns<Buffer> } = {}
  try {
    writeFileSync(file, initial)
    suspend(() => {
      // $EDITOR may carry arguments ("code --wait") — run it through the shell,
      // and pass the path as $0 so a filename with spaces survives.
      out.res = spawnSync("sh", ["-c", `${resolveEditor()} "$0"`, file], { stdio: "inherit" })
    })
    if (!out.res) return { kind: "failed", error: "Editor did not run." }
    if (out.res.error) return { kind: "failed", error: String(out.res.error.message ?? out.res.error) }
    const next = readFileSync(file, "utf-8")
    if (next.trim() === initial.trim()) return { kind: "unchanged" }
    if (!next.trim()) return { kind: "empty" }
    return { kind: "edited", text: next.trim() }
  } catch (err: unknown) {
    return { kind: "failed", error: err instanceof Error && err.message ? err.message : "Editor failed." }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
}
