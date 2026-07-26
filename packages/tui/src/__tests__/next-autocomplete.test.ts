import { describe, expect, test } from "vitest"
import type { RosterItem } from "@pipeline-moe/client-core"
import {
  PmoeAutocompleteProvider,
  commandItems,
  mentionItems,
  mentionPrefix,
  slashPrefix,
} from "../next/autocomplete.js"

// The palette and @mention completion, which used to be ~150 lines inside
// CommandLine.tsx and are now a pure function of (lines, cursorLine, cursorCol).
// pi-tui's Editor is happy to ask on every keystroke; what matters is that we
// answer null in exactly the cases where a dropdown would be noise or a lie.

const roster: RosterItem[] = [
  { id: "scout", name: "Scout", color: "#4A90D9", icon: "🔍", active: true } as RosterItem,
  { id: "builder", name: "Builder", color: "#EF9F27", icon: "🔨", active: true } as RosterItem,
  { id: "retired", name: "Retired", color: "#888888", icon: "💤", active: false } as RosterItem,
]

describe("slashPrefix", () => {
  test("offers the palette while the head is still one token", () => {
    expect(slashPrefix(["/rou"], 0, 4)).toBe("/rou")
    expect(slashPrefix(["/"], 0, 1)).toBe("/")
  })

  test("stops once an argument has begun — the command is already chosen", () => {
    // The Editor keeps asking after the space (its isInSlashCommandContext
    // allows arguments); a list of 35 commands under a half-typed argument is
    // the noise CommandLine's `!value.includes(" ")` existed to prevent.
    expect(slashPrefix(["/route se"], 0, 9)).toBeNull()
    expect(slashPrefix(["/route "], 0, 7)).toBeNull()
  })

  test("only the first line — a slash further down a draft is text", () => {
    expect(slashPrefix(["hello", "/usr/bin"], 1, 8)).toBeNull()
  })

  test("a slash that does not open the line is text", () => {
    expect(slashPrefix(["look at /etc"], 0, 12)).toBeNull()
  })

  test("the prefix is measured at the CURSOR, not at the end of the line", () => {
    expect(slashPrefix(["/resume"], 0, 3)).toBe("/re")
  })
})

describe("mentionPrefix", () => {
  test("an @ that opens a token", () => {
    expect(mentionPrefix(["@bui"], 0, 4)).toBe("@bui")
    expect(mentionPrefix(["ping @sc"], 0, 8)).toBe("@sc")
    expect(mentionPrefix(["@"], 0, 1)).toBe("@")
  })

  test("an address inside a word opens nothing — a pasted log is full of them", () => {
    expect(mentionPrefix(["dax@daxzeit.eu"], 0, 14)).toBeNull()
    expect(mentionPrefix(["root@host"], 0, 9)).toBeNull()
  })

  test("works on any line, unlike the palette", () => {
    expect(mentionPrefix(["first", "then @bu"], 1, 8)).toBe("@bu")
  })

  test("nothing once the mention is finished", () => {
    expect(mentionPrefix(["@builder go"], 0, 11)).toBeNull()
  })
})

describe("mentionItems", () => {
  test("active agents only — a mention of a retired one routes nowhere", () => {
    const vs = mentionItems(roster, "@").map((i) => i.value)
    expect(vs).toContain("@scout")
    expect(vs).toContain("@builder")
    expect(vs).not.toContain("@retired")
  })

  test("@all is offered, and offered LAST", () => {
    const vs = mentionItems(roster, "@").map((i) => i.value)
    // It is the loudest option in the room; it must not be what an empty
    // prefix highlights first.
    expect(vs[vs.length - 1]).toBe("@all")
  })

  test("filters case-insensitively on the id", () => {
    expect(mentionItems(roster, "@BU").map((i) => i.value)).toEqual(["@builder"])
    expect(mentionItems(roster, "@zz")).toEqual([])
  })

  test("the description names the agent, so the id is not the only clue", () => {
    expect(mentionItems(roster, "@sc")[0]!.description).toContain("Scout")
  })
})

describe("commandItems", () => {
  test("a prefix narrows to real commands and keeps the slash in the value", () => {
    const items = commandItems("/rou")
    expect(items.length).toBeGreaterThan(0)
    for (const i of items) expect(i.value.startsWith("/rou")).toBe(true)
  })

  test("an alias completes to the ALIAS typed, not to the canonical name", () => {
    // Otherwise typing an alias would rewrite itself under the cursor.
    const items = commandItems("/")
    const values = items.map((i) => i.value)
    expect(new Set(values).size).toBe(values.length)
  })

  test("a head that matches nothing yields nothing to show", () => {
    expect(commandItems("/zzzz")).toEqual([])
  })
})

describe("PmoeAutocompleteProvider", () => {
  const p = new PmoeAutocompleteProvider(() => roster)

  test("commands and mentions come back with the prefix that must be replaced", async () => {
    const cmd = await p.getSuggestions(["/res"], 0, 4)
    expect(cmd?.prefix).toBe("/res")
    const at = await p.getSuggestions(["@sc"], 0, 3)
    expect(at?.prefix).toBe("@sc")
  })

  test("the slash prefix keeps its slash — that is what makes ⏎ RUN the command", () => {
    // The Editor applies the completion and falls through to submit only when
    // the prefix starts with "/" (components/editor.js). Losing the slash here
    // would silently turn ⏎ into a completion that needs a second ⏎.
    expect(slashPrefix(["/res"], 0, 4)!.startsWith("/")).toBe(true)
  })

  test("plain text suggests nothing", async () => {
    expect(await p.getSuggestions(["just talking"], 0, 12)).toBeNull()
  })

  test("no suggestions at all rather than an empty dropdown", async () => {
    expect(await p.getSuggestions(["/zzzz"], 0, 5)).toBeNull()
    expect(await p.getSuggestions(["@zzzz"], 0, 5)).toBeNull()
  })

  test("applying a mention adds a trailing space, applying a command does not", () => {
    const m = p.applyCompletion(["ping @sc"], 0, 8, { value: "@scout", label: "@scout" }, "@sc")
    expect(m.lines[0]).toBe("ping @scout ")
    expect(m.cursorCol).toBe(12)
    // A command with no arguments submits straight after applying; a trailing
    // space would be the only thing between the name and the send.
    const c = p.applyCompletion(["/res"], 0, 4, { value: "/resume", label: "/resume" }, "/res")
    expect(c.lines[0]).toBe("/resume")
  })

  test("completion preserves the text AFTER the cursor", () => {
    const r = p.applyCompletion(["@sc please look"], 0, 3, { value: "@scout", label: "@scout" }, "@sc")
    expect(r.lines[0]).toBe("@scout  please look")
  })

  test("completion leaves other lines untouched", () => {
    const r = p.applyCompletion(["keep me", "@sc"], 1, 3, { value: "@scout", label: "@scout" }, "@sc")
    expect(r.lines[0]).toBe("keep me")
    expect(r.lines[1]).toBe("@scout ")
  })

  test("local file completion is refused — the workspace is the SERVER's", () => {
    expect(p.shouldTriggerFileCompletion()).toBe(false)
  })
})
