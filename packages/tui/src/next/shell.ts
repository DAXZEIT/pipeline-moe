// `!` shell mode for the pi-tui client.
//
// Same contract as the Ink client: run in the room's workspace, then let the user
// decide whether the capture becomes shared context. What changes is how the
// terminal is handed over, and that is the interesting part.
//
// THE ALT SCREEN IS GONE, AND THAT IS NOT A SIMPLIFICATION
//
// The Ink client left the alternate screen for the duration of the command, so
// the output landed in the normal buffer's scrollback and Ink's frame stayed
// safely parked. This client has no alt screen — the conversation itself lives in
// the normal scrollback. So the command's output appends right after the app's
// last frame, which is exactly where it belongs, and the only problem is coming
// back: pi-tui's diff still believes its frame occupies the rows the shell output
// just overwrote.
//
// The obvious fix is wrong. `tui.requestRender(true)` resets the diff, but it
// gets there by invalidating the width and height, which routes into
// `fullRender(clear)` — `\x1b[2J\x1b[H\x1b[3J`, screen AND scrollback. That would
// erase the shell output we just ran the command to see, and the whole
// conversation with it.
//
// What is needed is narrower: forget the previous frame, keep the dimensions.
// pi-tui then takes its "first render — assumes clean screen" path and re-prints
// the app BELOW the shell output, with everything above preserved. There is no
// public API for that (tui.js line 1060 is the branch), so this reaches for the
// private field, guarded — if a version bump ever renames it we fall back to the
// clearing redraw, which is ugly but correct rather than a crash.

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import chalk from "chalk"
import { SelectList, type TUI } from "@earendil-works/pi-tui"
import type { RoomStore } from "@pipeline-moe/client-core"
import { cleanPtyCapture, exitCodeOf } from "../pty-capture"

export interface ShellDeps {
  tui: TUI
  /** Read at call time: a room switch replaces the store, and a capture posted to
   *  the room the user just left is worse than one not posted at all. */
  store: () => RoomStore
  /** The room's workspace on the SERVER. Undefined when the server did not
   *  report one, which is also how a pre-0.1.11 server looks. */
  workspaceDir: () => string | undefined
  /** Restore focus to the editor once the share prompt closes. */
  refocus: () => void
}

/** Resume the app after a foreign process wrote to the terminal, WITHOUT
 *  clearing the scrollback. See the module comment for why this is not
 *  `requestRender(true)`. Exported because `/prompt`'s $EDITOR needs exactly the
 *  same thing — "someone else drew on this terminal, re-print below whatever they
 *  left" is not specific to `!`. */
export function resumeBelow(tui: TUI): void {
  const priv = tui as unknown as { previousLines?: unknown }
  if (Array.isArray(priv.previousLines)) {
    priv.previousLines = []
    tui.requestRender()
  } else {
    // The field moved. Correct, but it costs the scrollback.
    tui.requestRender(true)
  }
}

export function createShellRunner(deps: ShellDeps): (command: string) => void {
  const { tui } = deps
  const store = (): RoomStore => deps.store()

  const serverSide = (command: string, why: string): void => {
    store().pushNotice(`$ ${command} — running non-interactively on the server (${why}).`)
    store().actions
      .runShell(command)
      .catch((err: unknown) =>
        store().pushNotice(
          err instanceof Error && err.message ? err.message : "Shell failed — server unreachable?",
          "error",
        ),
      )
  }

  /** The user decides AFTER the run whether the capture becomes shared context —
   *  an hour of ping output would otherwise spam every agent's next turn with no
   *  way to stop it. Esc keeps it private. */
  const askToShare = (command: string, output: string, exit: number): void => {
    const lines = output ? output.split("\n").filter((l) => l.trim()).length : 0
    const keepPrivate = (): void => store().pushNotice(`$ ${command} — output kept private.`)
    const list = new SelectList(
      [
        { value: "send", label: "Send to chat", description: "shared context for all agents" },
        { value: "keep", label: "Keep private", description: "nothing posted" },
      ],
      2,
      {
        selectedPrefix: (s) => chalk.cyan(s),
        selectedText: (s) => chalk.cyan(s),
        description: (s) => chalk.dim(s),
        scrollInfo: (s) => chalk.dim(s),
        noMatch: (s) => chalk.dim(s),
      },
    )
    const handle = tui.showOverlay(list, { width: "60%", anchor: "center" })
    const close = (): void => {
      handle.hide()
      deps.refocus()
      tui.requestRender()
    }
    list.onCancel = (): void => {
      close()
      keepPrivate()
    }
    list.onSelect = (item): void => {
      close()
      if (item.value !== "send") return keepPrivate()
      store().actions
        .postShellRecord(command, output, exit)
        .catch((err: unknown) =>
          store().pushNotice(
            err instanceof Error && err.message ? err.message : "Failed to record shell output.",
            "error",
          ),
        )
    }
    store().pushNotice(`$ ${command} — ${lines} line${lines === 1 ? "" : "s"} captured. Share?`)
    tui.requestRender()
  }

  return (command: string): void => {
    const ws = deps.workspaceDir()
    if (!ws) return serverSide(command, "server didn't report a workspace — restart it if it predates 0.1.11")
    if (!existsSync(ws)) return serverSide(command, "workspace not on this machine")
    if (!process.stdin.isTTY) return serverSide(command, "no tty")

    const dir = mkdtempSync(join(tmpdir(), "pmoe-shell-"))
    const capture = join(dir, "capture")

    // Hand the terminal over: stop() parks the cursor after the app's last line
    // and restores the cooked-mode cursor, so the child starts on a clean row.
    tui.stop()
    process.stdout.write(`\n${chalk.red("$")} ${command}\n`)
    // `script -c` runs the command through $SHELL — pin it to bash so `!` has
    // the same semantics as the server-side runner regardless of the user's
    // login shell (zsh's `read -p` means coprocess, fish differs more).
    const env = { ...process.env, SHELL: "/bin/bash" }
    const res =
      process.platform === "darwin"
        ? spawnSync("script", ["-q", capture, "bash", "-c", command], { stdio: "inherit", cwd: ws, env })
        : spawnSync("script", ["-qefc", command, capture], { stdio: "inherit", cwd: ws, env })
    tui.start()
    resumeBelow(tui)

    let output = ""
    try {
      output = cleanPtyCapture(readFileSync(capture, "utf8"))
    } catch {}
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}

    if (res.error) return serverSide(command, "no `script` binary on this host")
    askToShare(command, output, exitCodeOf(res, output))
  }
}
