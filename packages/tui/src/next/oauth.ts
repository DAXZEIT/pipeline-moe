// The OAuth device-flow panel.
//
// The plan called this one "blocking, so it wants a captured overlay", and that is
// exactly how it lands. In the Ink client it was a chrome panel with
// `isActive={!overlay}` — visible below the conversation, competing for the
// keyboard with whatever else happened to be open. Here it is a real overlay
// layer, pushed when a flow starts and popped when it ends, which means focus is
// pi-tui's problem and not a boolean.
//
// TWO THINGS THE LIBRARY DOES BETTER THAN OUR COPY DID:
//
//   - `hyperlink()` is pi-tui's own OSC 8 encoder. `OAuthPanel.tsx` carried the
//     escape sequence by hand ("same encoding pi uses" — it was literally pi's).
//     One copy now, and the Ink panel reads it from the library too.
//   - The input line is pi-tui's `Input`, so pasting a redirect URL gets bracketed
//     paste, word motions and a kill-ring. Ink's version hand-rolled the key
//     handling and, because it could not scroll a field, DISPLAYED the value as
//     "…" + the last 59 characters. A redirect URL is precisely the string where
//     the interesting part (the `code=` parameter) is at the end AND the user
//     needs to see whether the paste arrived whole.
//
// WHY IT TAKES FOCUS EVEN OVER AN OPEN OVERLAY: the flow was started by the user,
// seconds ago, with /login. The panel carries a code that expires. An overlay that
// waited politely for the roster picker to close would be showing a dead code by
// the time it got the screen.

import chalk from "chalk"
import { Input, hyperlink, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui"
import type { OAuthProgress } from "@pipeline-moe/client-core"
import { fitLine, frame } from "./overlay-frame"

const clickHint = process.platform === "darwin" ? "⌘+click to open ↗" : "Ctrl+click to open ↗"

export interface OAuthPanelOptions {
  /** Read live: the same flow moves from device_code to progress to success, and
   *  the panel is one component through all of it. */
  progress: () => OAuthProgress | null
  onDismiss: () => void
  onSubmitInput: (value: string) => void
}

/** Which statuses are terminal — ⏎ dismisses instead of submitting. */
function isDone(p: OAuthProgress): boolean {
  return p.status === "success" || p.status === "error"
}
/** Which statuses want a pasted value: the browser ran somewhere else and the
 *  localhost callback never fired. */
function wantsInput(p: OAuthProgress): boolean {
  return p.status === "auth_url" || p.status === "prompt"
}

export class OAuthPanelComponent implements Component, Focusable {
  private input = new Input()

  constructor(private opts: OAuthPanelOptions) {
    this.input.onSubmit = (v: string): void => {
      const p = this.opts.progress()
      if (!p) return
      if (isDone(p)) return this.opts.onDismiss()
      const t = v.trim()
      if (t && wantsInput(p)) {
        this.opts.onSubmitInput(t)
        this.input.setValue("")
      }
    }
    this.input.onEscape = (): void => this.opts.onDismiss()
  }

  get focused(): boolean {
    return this.input.focused
  }
  set focused(v: boolean) {
    this.input.focused = v
  }

  invalidate(): void {
    this.input.invalidate()
  }

  handleInput(data: string): void {
    const p = this.opts.progress()
    if (matchesKey(data, "escape")) return this.opts.onDismiss()
    // Nothing to type into: ⏎ dismisses, and no other key should be swallowed
    // into an invisible buffer while "Waiting for authorization…" is on screen.
    if (!p || !wantsInput(p)) {
      if (matchesKey(data, "enter")) this.opts.onDismiss()
      return
    }
    this.input.handleInput(data)
  }

  render(width: number): string[] {
    const p = this.opts.progress()
    if (!p) return []
    const inner = width - 4
    const done = isDone(p)
    const asks = wantsInput(p)
    const color = p.status === "error" ? "red" : p.status === "success" ? "green" : "cyan"
    const body: string[] = []
    const link = (text: string, url: string): string => hyperlink(text, url)

    if (p.status === "device_code") {
      if (p.verificationUri) {
        body.push(fitLine("Visit " + chalk.cyan.underline(link(p.verificationUri, p.verificationUri)), inner))
        body.push(fitLine(chalk.dim(link(clickHint, p.verificationUri)), inner))
      }
      body.push(fitLine(`Enter code ${chalk.yellow.bold(p.userCode ?? "")}`, inner))
    }
    if (asks) {
      const said = p.status === "prompt" ? p.message : p.instructions
      if (said) body.push(fitLine(said, inner))
      if (p.url) {
        body.push(fitLine(chalk.cyan.underline(link(p.url, p.url)), inner))
        body.push(fitLine(chalk.dim(link(clickHint, p.url)), inner))
      }
      body.push(
        ...(this.input.getValue()
          ? this.input.render(inner)
          : [chalk.yellow("› ") + chalk.dim(p.placeholder ?? "paste the redirect URL here if needed")]),
      )
    }
    if (p.status === "progress") body.push(chalk.dim(p.message ?? "Waiting for authorization…"))
    if (p.status === "success") body.push(chalk.green(`✓ ${p.message || "Authenticated."}`))
    if (p.status === "error") body.push(chalk.red(`✗ ${p.message || "Login failed."}`))

    return frame(
      {
        title: `OAuth · ${p.provider || "provider"}`,
        body,
        hint: done
          ? "esc / ⏎ dismiss"
          : asks
            ? "finish in your browser · ⏎ submit pasted URL · esc cancel"
            : "finish in your browser · esc cancel",
        color,
      },
      width,
    )
  }
}
