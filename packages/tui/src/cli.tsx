#!/usr/bin/env -S npx tsx
// pmoe — pipeline-moe terminal client. Connects to a running server and renders
// one room. The whole client lives in @pipeline-moe/client-core; this entry just
// wires the Node SSE transport and mounts the Ink app.
//
//   pmoe [--server http://localhost:5300] [--room default]

import { appendFileSync } from "node:fs"
import { render } from "ink"
import { createRoomStore, createApi } from "@pipeline-moe/client-core"
import { nodeEventSourceFactory } from "./nodeEventSource"
import { App } from "./App"

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

// Pop any leaked kitty-keyboard-protocol enhancement before Ink takes stdin.
// Some terminal/shell combos (fish 4 pushes the protocol at its prompt) can
// leave the terminal in CSI-u mode, where Esc arrives as "\x1b[27u", Enter as
// "\x1b[13u" and Ctrl+C as "\x1b[99;5u" — sequences Ink doesn't parse, which
// makes the whole UI (and Ctrl+C) appear frozen. Popping an empty stack is a
// spec-defined no-op, and terminals without the protocol ignore the sequence.
if (process.stdout.isTTY) process.stdout.write("\x1b[<u")

// Synchronized output (DEC private mode 2026): bracket every frame write so
// the terminal applies Ink's erase-and-redraw atomically instead of painting
// the intermediate blank state — the source of menu-navigation flicker.
// Terminals without support (rare now: Ghostty/kitty/WezTerm/recent tmux all
// have it) ignore the sequences.
if (process.stdout.isTTY) {
  const rawWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array, enc?: unknown, cb?: unknown) =>
    rawWrite(
      typeof chunk === "string" ? `\x1b[?2026h${chunk}\x1b[?2026l` : chunk,
      enc as never,
      cb as never,
    )) as typeof process.stdout.write
}

// Diagnostic tap: PMOE_INPUT_LOG=<file> appends every stdin chunk Ink consumes,
// JSON-escaped so escape sequences are readable. Costs nothing when unset.
const inputLog = process.env.PMOE_INPUT_LOG
if (inputLog) {
  const origRead = process.stdin.read.bind(process.stdin)
  ;(process.stdin as NodeJS.ReadStream).read = ((size?: number) => {
    const chunk = origRead(size)
    if (chunk != null) {
      try {
        appendFileSync(inputLog, JSON.stringify(String(chunk)) + "\n")
      } catch {}
    }
    return chunk
  }) as typeof process.stdin.read
}

const apiBase = arg("--server", process.env.PMOE_SERVER ?? "http://localhost:5300")
const roomId = arg("--room", "default")

const { api } = createApi(apiBase)
const makeStore = (id: string) =>
  createRoomStore({ apiBase, roomId: id, eventSourceFactory: nodeEventSourceFactory })

const { waitUntilExit } = render(<App makeStore={makeStore} api={api} initialRoomId={roomId} />)
waitUntilExit().then(() => process.exit(0))
