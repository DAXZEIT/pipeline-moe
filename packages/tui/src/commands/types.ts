import type { RoomStore, Api, RoomState, PresetFile } from "@pipeline-moe/client-core"

/** One selectable row in a generic SelectOverlay. */
export interface SelectItem {
  id: string
  label: string
  /** Dimmed trailing text (counts, models, timestamps…). */
  hint?: string
}

/**
 * A modal the command line can raise over the transcript. `select` is the
 * reusable list picker; `textInput` a one-line prompt (maskable, for secrets);
 * `lineup` and `agentForm` are bespoke interactive forms.
 */
export type Overlay =
  | {
      kind: "select"
      title: string
      items: SelectItem[]
      emptyText?: string
      onSelect: (id: string) => void
      /** Runs after Esc closes the overlay — lets a submenu reopen its parent. */
      onCancel?: () => void
    }
  | {
      kind: "textInput"
      title: string
      placeholder?: string
      /** Render the value as bullets (all but the last 4 chars) — for API keys. */
      mask?: boolean
      onSubmit: (value: string) => void
    }
  | { kind: "lineup" }
  | { kind: "agentForm" }
  | { kind: "roomForm" }
  | { kind: "prompt"; agentId: string }
  | {
      kind: "presetDetail"
      preset: PresetFile
      /** Reopen the preset list when Esc backs out of the detail view. */
      onBack?: () => void
    }

/** Everything a command needs to act, injected by the App at dispatch time. */
export interface CommandContext {
  store: RoomStore
  /** Process-global REST surface, for fetching lists (templates, presets, models). */
  api: Api
  /** Snapshot of room state captured when the command was dispatched. */
  state: RoomState
  /** Surface transient feedback through the shared notice channel. */
  notify: (msg: string, level?: "info" | "error") => void
  /** Switch the active room — disposes the current store and binds a new one. */
  switchRoom: (roomId: string) => void
  openOverlay: (o: Overlay) => void
  closeOverlay: () => void
}

export interface Command {
  name: string
  summary: string
  /** Argument shape shown in the palette, e.g. "<auto|semi|manual>". */
  usage?: string
  run: (ctx: CommandContext, args: string) => void | Promise<void>
}
