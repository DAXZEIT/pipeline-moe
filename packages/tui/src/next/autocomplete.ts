// Autocomplete for the pi-tui client: slash commands and @mention routing.
//
// pi-tui's Editor owns the mechanics — trigger detection, debouncing, aborting,
// the dropdown, Tab/Enter arbitration — and asks a provider what to offer. So
// what used to be the palette half of CommandLine.tsx is now a pure function of
// (lines, cursorLine, cursorCol): no component, no state, no terminal.
//
// It deliberately does NOT extend pi-tui's CombinedAutocompleteProvider. That
// one reads `@` as a path prefix and completes local files, which is wrong here
// twice over: `@` means an AGENT in this client, and the workspace a command
// would touch lives on the server, not on this machine.
//
// Two behaviours from the Ink palette are kept exactly:
//
//   - the palette only offers commands while the head is still one token
//     (`/rou`), never once an argument has been typed (`/route se`). The Editor
//     is happy to keep asking after a space; we answer null, because a list of
//     commands is noise once you are typing an argument.
//   - Enter on a highlighted command RUNS it: `/r`⏎ on ▶/resume runs /resume
//     rather than the ambiguous `/r`. That is the Editor's own rule for a prefix
//     starting with "/" — it applies the completion and falls through to submit
//     (components/editor.js: `autocompletePrefix.startsWith("/")`).

import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui"
import type { RosterItem } from "@pipeline-moe/client-core"
import { commandPaletteLabel, matchCommands } from "../commands/registry"

/** The head of a slash command, if the cursor sits inside it.
 *
 *  Only on the FIRST line: a "/" further down a multiline draft is text (a path,
 *  a fraction), and the Editor agrees — its `isSlashMenuAllowed` is the same
 *  test, but we cannot rely on that alone since it also fires mid-argument. */
export function slashPrefix(lines: string[], cursorLine: number, cursorCol: number): string | null {
  if (cursorLine !== 0) return null
  const before = (lines[0] ?? "").slice(0, cursorCol)
  if (!before.startsWith("/")) return null
  // Whitespace anywhere means an argument has begun — the command is chosen.
  if (/\s/.test(before)) return null
  return before
}

/** The `@partial` token under the cursor, if any.
 *
 *  The `@` must open a token (start of line or after whitespace) so an email or
 *  a `user@host` in a pasted log does not open a roster list. */
export function mentionPrefix(lines: string[], cursorLine: number, cursorCol: number): string | null {
  const before = (lines[cursorLine] ?? "").slice(0, cursorCol)
  const m = /(^|\s)(@[\w-]*)$/.exec(before)
  return m ? m[2]! : null
}

/** Every id an @mention can name: the active roster, plus @all. */
export function mentionItems(roster: RosterItem[], prefix: string): AutocompleteItem[] {
  const q = prefix.slice(1).toLowerCase()
  const items: AutocompleteItem[] = roster
    .filter((r) => r.active)
    .map((r) => ({
      value: `@${r.id}`,
      label: `@${r.id}`,
      description: `${r.icon} ${r.name}`,
    }))
  // @all last: it is the loudest option in the room, so it should not be the
  // one an empty prefix highlights first.
  items.push({ value: "@all", label: "@all", description: "everyone active" })
  return items.filter((i) => i.value.slice(1).toLowerCase().startsWith(q))
}

export function commandItems(prefix: string): AutocompleteItem[] {
  return matchCommands(prefix.slice(1)).map((m) => ({
    value: `/${m.matched}`,
    label: commandPaletteLabel(m),
    description: m.command.summary,
  }))
}

export class PmoeAutocompleteProvider implements AutocompleteProvider {
  // "/" is not listed: the Editor detects slash context itself and would
  // double-trigger. "@" needs declaring, or a bare "@" opens nothing.
  triggerCharacters = ["@"]

  constructor(private roster: () => RosterItem[]) {}

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): Promise<AutocompleteSuggestions | null> {
    const slash = slashPrefix(lines, cursorLine, cursorCol)
    if (slash !== null) {
      const items = commandItems(slash)
      return items.length > 0 ? { items, prefix: slash } : null
    }
    const mention = mentionPrefix(lines, cursorLine, cursorCol)
    if (mention !== null) {
      const items = mentionItems(this.roster(), mention)
      return items.length > 0 ? { items, prefix: mention } : null
    }
    return null
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    // A mention is followed by a space — you always type something after it.
    // A command is not: for a command WITHOUT arguments the Editor submits
    // straight after applying, and a trailing space would be the only thing
    // between the name and a send.
    const insert = item.value.startsWith("@") ? item.value + " " : item.value
    const line = lines[cursorLine] ?? ""
    const start = Math.max(0, cursorCol - prefix.length)
    const next = [...lines]
    next[cursorLine] = line.slice(0, start) + insert + line.slice(cursorCol)
    return { lines: next, cursorLine, cursorCol: start + insert.length }
  }

  /** No local file completion: the workspace a command reaches is the SERVER's.
   *  Offering this machine's files would be a lie with a working dropdown. */
  shouldTriggerFileCompletion(): boolean {
    return false
  }
}
