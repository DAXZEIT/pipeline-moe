import type { RoutingMode } from "@pipeline-moe/client-core"

/**
 * The input box speaks the mode through its border color, so you know where a
 * keystroke lands before pressing ⏎: "/" = command mode, "!" = shell mode,
 * plain text = a room message whose dispatch depends on the routing mode.
 * One color per meaning, shared with the status bar's routing segment.
 */

export type InputMode = "slash" | "bang" | "text"

export function inputMode(value: string): InputMode {
  if (value.startsWith("/")) return "slash"
  if (value.startsWith("!")) return "bang"
  return "text"
}

/** Routing colors double as the plain-text border: cyan = auto (the room
 *  decides), blue = semi (proposals need your ⏎), gray = manual (nothing moves
 *  without an @mention), magenta = supervised (the supervisor agent decides). */
export const ROUTING_COLOR: Record<RoutingMode, string> = {
  auto: "cyan",
  semi: "blue",
  manual: "gray",
  supervised: "magenta",
}

/** Border color for the input box. `live` = focused AND connected — a dead or
 *  covered input stays gray regardless of mode (the caller dims it too, so
 *  manual-gray and dead-gray don't read the same). */
export function inputBorderColor(mode: InputMode, routing: RoutingMode, live: boolean): string {
  if (!live) return "gray"
  if (mode === "slash") return "yellow"
  if (mode === "bang") return "red"
  return ROUTING_COLOR[routing]
}

/** Mode label shown dim inside the box while the command part is still empty —
 *  names the mode the prompt glyph only implies (typing "!" alone previously
 *  gave no feedback at all beyond the glyph). */
export function inputModeHint(mode: InputMode): string | null {
  if (mode === "bang") return "shell mode — ⏎ runs in the room workspace"
  if (mode === "slash") return "command mode"
  return null
}
