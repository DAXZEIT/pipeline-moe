// `/prompt @agent` — read an agent's system prompt, and edit it in $EDITOR.
//
// The pager is a window over lines, like the task board. What is new is that this
// overlay LEAVES: `e` hands the terminal to the user's editor, which means the
// renderer has to get out of the way and come back. On Ink that was
// `setRawMode(false)` around a blocking `spawnSync`; here it is `tui.stop()` /
// `tui.start()`, which pi-tui documents as the suspend/resume path (its
// `terminal.start()` even re-fires SIGWINCH, because the window may have been
// resized while the editor owned the screen). The dance itself is shared with the
// Ink client in `external-editor.ts` — only the release differs.
//
// COMING BACK KEEPS THE SCROLLBACK, which is the part that matters and is not
// what `requestRender(true)` does. That one invalidates the dimensions, and pi-tui
// answers a dimension change with `\x1b[2J\x1b[H\x1b[3J` — screen AND scrollback,
// i.e. the whole conversation. `!` shell mode had already solved this
// (`resumeBelow`): forget the previous frame, keep the dimensions, and pi-tui takes
// its "first render — assumes clean screen" path, which re-prints BELOW whatever
// the child left. Measured live (2026-07-26): `fullRedraws` goes 1 → 2 and the log
// says `fullRender: first render (prev=0, new=46)` — that branch calls
// `fullRender(false)`, so the counter moves but nothing is erased, and the turn
// from before the edit was still on screen afterwards. "Someone else drew on this
// terminal" is one problem with one answer, so the client passes the same one in.
//
// ONE DELIBERATE DIFFERENCE FROM INK: long lines WRAP here instead of being cut
// at the width (`l.slice(0, width)` in PromptOverlay.tsx). A pager whose entire
// job is reading a prompt should not hide the end of every paragraph — Ink's
// truncation was a consequence of its fixed-height row budget, not a choice, and
// pi-tui hands us `wrapTextWithAnsi` for nothing.

import chalk from "chalk"
import { matchesKey, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui"
import type { PersonaDetail, RoomStore } from "@pipeline-moe/client-core"
import { editText } from "../external-editor"
import { frame, moreMarker } from "./overlay-frame"
import type { Rows } from "./overlays"

export interface PromptOverlayOptions {
  agentId: string
  store: RoomStore
  onClose: () => void
  /** Release the terminal for the editor and take it back after — the client
   *  passes `tui.stop()` / `tui.start()` + `resumeBelow`. */
  suspend: (run: () => void) => void
  requestRender: () => void
}

/** Pager height: the frame's three chrome rows, the two markers, and enough of
 *  the conversation left visible to know which room you are in. */
function pageRows(rows: number): number {
  return Math.max(4, Math.min(20, rows - 12))
}

export class PromptOverlayComponent implements Component, Focusable {
  focused = false
  private detail: PersonaDetail | null = null
  private error: string | null = null
  private scroll = 0
  /** Wrapped once per (prompt, width) — a resize or a save re-wraps, a scroll
   *  does not. */
  private wrapped: { text: string; width: number; lines: string[] } | null = null
  /** `e` while the editor is already up would spawn a second one on top of the
   *  first; both would write the same temp file and the last one out would win. */
  private editing = false

  constructor(
    private opts: PromptOverlayOptions,
    private rows: Rows = () => process.stdout.rows ?? 24,
  ) {
    opts.store.actions
      .getParticipant(opts.agentId)
      .then((d) => {
        this.detail = d
        opts.requestRender()
      })
      .catch(() => {
        this.error = "Failed to load the agent."
        opts.requestRender()
      })
  }

  invalidate(): void {}

  private lines(width: number): string[] {
    const text = this.detail?.systemPrompt ?? ""
    if (this.wrapped && this.wrapped.text === text && this.wrapped.width === width) return this.wrapped.lines
    // A blank line in the prompt must stay a blank line: wrapTextWithAnsi drops
    // empty segments, so paragraphs are wrapped one at a time.
    const lines = text.split("\n").flatMap((l) => (l.trim() ? wrapTextWithAnsi(l, width) : [" "]))
    this.wrapped = { text, width, lines }
    return lines
  }

  private openEditor(): void {
    if (!this.detail || this.editing) return
    this.editing = true
    const { agentId, store, onClose, suspend, requestRender } = this.opts
    try {
      const outcome = editText(this.detail.systemPrompt, { basename: `${agentId}.md`, suspend })
      switch (outcome.kind) {
        case "unchanged":
          store.pushNotice("System prompt unchanged.")
          return
        case "empty":
          this.error = "Empty prompt — not saved."
          return
        case "failed":
          this.error = `Editor failed: ${outcome.error}`
          return
        case "edited":
          store.actions
            .updateParticipant(agentId, { systemPrompt: outcome.text })
            .then(() => {
              store.pushNotice(`@${agentId} system prompt updated.`)
              onClose()
            })
            .catch((err: unknown) => {
              this.error = err instanceof Error && err.message ? err.message : "Save failed."
              requestRender()
            })
          return
      }
    } finally {
      this.editing = false
      requestRender()
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) return this.opts.onClose()
    if (data === "e") return this.openEditor()
    const page = pageRows(this.rows())
    // The scroll bound needs the line count, which needs the width — which
    // `handleInput` is not given. The last render's wrap is the right answer
    // (it is what is on screen); before the first render there is nothing to
    // scroll anyway.
    const total = this.wrapped?.lines.length ?? 0
    const maxScroll = Math.max(0, total - page)
    if (matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1)
    else if (matchesKey(data, "down")) this.scroll = Math.min(maxScroll, this.scroll + 1)
    else if (matchesKey(data, "pageUp")) this.scroll = Math.max(0, this.scroll - page)
    else if (matchesKey(data, "pageDown")) this.scroll = Math.min(maxScroll, this.scroll + page)
  }

  render(width: number): string[] {
    const inner = width - 4
    const lines = this.lines(inner)
    const page = pageRows(this.rows())
    const at = Math.min(this.scroll, Math.max(0, lines.length - page))
    const body: string[] = []
    if (!this.detail && !this.error) body.push(chalk.dim("Loading…"))
    if (this.detail && lines.length === 0) body.push(chalk.dim("(no system prompt)"))
    body.push(moreMarker(at > 0, "▲"))
    body.push(...lines.slice(at, at + page))
    body.push(moreMarker(at + page < lines.length, "▼"))
    if (this.error) body.push(chalk.red(this.error))

    const who = this.detail ? `${this.detail.icon} ${this.detail.name}` : this.opts.agentId
    return frame(
      {
        title: `System prompt · ${who}`,
        ...(lines.length > page
          ? { titleRight: `${at + 1}-${Math.min(at + page, lines.length)}/${lines.length}` }
          : {}),
        body,
        hint: "↑↓ scroll · ⇞⇟ page · e edit in $EDITOR · esc close",
        color: "magenta",
      },
      width,
    )
  }
}
