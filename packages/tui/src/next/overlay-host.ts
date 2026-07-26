// Raising an overlay, and taking it down again.
//
// This is where pi-tui's overlay system replaces the Ink client's single-modal
// model. `showOverlay` gives 9 anchors, percentage sizing, real stacking and
// focus restore; the Ink client had one `overlay` state field and a full-frame
// component, which is why `RoomForm.tsx` had to invent a `picking` flag to fake a
// second level (Phase 4 deletes that hack rather than porting it).
//
// REGISTRY OVERLAYS STILL REPLACE, AND THAT IS DELIBERATE.
//
// The stack is adopted, but `commands/registry.ts` was written against a model
// where opening an overlay replaces the current one, and it compensates with
// `onCancel` callbacks that reopen the parent by hand — /model is a loop of
// pickers built exactly that way. If a registry `openOverlay` pushed instead,
// Esc would pop back to the parent AND `onCancel` would reopen it: two parents,
// one of them a ghost. So `open()` replaces the top of the stack, faithfully,
// and the registry keeps working unchanged (gate 5's spirit: the framework-free
// layer does not move to suit the renderer).
//
// Genuine stacking is therefore adopted but not yet exercised: the `!` shell
// share prompt raises its own overlay outside this host, and Phase 4 is where a
// form raising a picker becomes the case the stack exists for. Nothing here
// depends on the stack being one deep — `open()` replaces because the registry
// expects it to, not because pi-tui cannot do better.

import type { OverlayHandle, TUI } from "@earendil-works/pi-tui"
import type { RoomStore } from "@pipeline-moe/client-core"
import type { Overlay } from "../commands/types"
import {
  LineupOverlayComponent,
  PresetPickerOverlayComponent,
  SelectOverlayComponent,
  TasksOverlayComponent,
  TextInputOverlayComponent,
} from "./overlays"

/** The kinds this phase serves. Everything else falls through to the caller,
 *  which posts a notice naming the phase that brings it. */
const HANDLED = new Set<Overlay["kind"]>(["select", "textInput", "tasks", "lineup", "presetPicker"])

export interface OverlayHostDeps {
  tui: TUI
  store: RoomStore
  /** Where focus goes when the last overlay closes. */
  refocus: () => void
  /** Raise a command by name — `a` in the line-up opens the add-agent flow, and
   *  that flow is a registry command, not something this module should know. */
  runCommand: (input: string) => void
}

export class OverlayHost {
  private handle: OverlayHandle | null = null
  /** The overlay's own cancel callback, so Esc and a programmatic close behave
   *  identically — a submenu that reopens its parent must do so either way. */
  private onCancel: (() => void) | null = null

  constructor(private deps: OverlayHostDeps) {}

  isOpen(): boolean {
    return this.handle !== null
  }

  /** Take the current overlay down without running its cancel callback. Used
   *  when something REPLACES it, and by an overlay that finished its job. */
  close(): void {
    if (!this.handle) return
    this.handle.hide()
    this.handle = null
    this.onCancel = null
    this.deps.refocus()
    this.deps.tui.requestRender()
  }

  /** Esc, or /close-style dismissal: down it goes, and its cancel callback runs
   *  — that is what lets a submenu reopen the menu that raised it. */
  cancel(): void {
    const cb = this.onCancel
    this.close()
    cb?.()
  }

  open(o: Overlay): boolean {
    if (!HANDLED.has(o.kind)) return false
    const { tui, store } = this.deps
    // Replace, don't stack — see the module comment.
    if (this.handle) {
      this.handle.hide()
      this.handle = null
      this.onCancel = null
    }

    const component = this.build(o)
    if (!component) return false
    this.onCancel = "onCancel" in o && o.onCancel ? o.onCancel : null
    // 80% wide, centred, capped at most of the screen. The conversation stays
    // visible around it, which is the point of an overlay rather than a screen.
    this.handle = tui.showOverlay(component, { width: "80%", minWidth: 40, maxHeight: "80%", anchor: "center" })
    this.handle.focus()
    tui.requestRender()
    void store
    return true
  }

  private build(o: Overlay): SelectOverlayComponent | TextInputOverlayComponent | TasksOverlayComponent | LineupOverlayComponent | PresetPickerOverlayComponent | null {
    const { store, runCommand } = this.deps
    switch (o.kind) {
      case "select":
        return new SelectOverlayComponent({
          title: o.title,
          items: o.items,
          ...(o.emptyText !== undefined ? { emptyText: o.emptyText } : {}),
          // A selection closes the overlay BEFORE acting. Commands routinely
          // open the next overlay from inside onSelect (/model is a loop of
          // them), and closing after would tear down the one just raised.
          onSelect: (id) => {
            this.close()
            o.onSelect(id)
          },
          onCancel: () => this.cancel(),
        })
      case "textInput":
        return new TextInputOverlayComponent({
          title: o.title,
          ...(o.placeholder !== undefined ? { placeholder: o.placeholder } : {}),
          ...(o.mask !== undefined ? { mask: o.mask } : {}),
          onSubmit: (v) => {
            this.close()
            o.onSubmit(v)
          },
          onCancel: () => this.cancel(),
        })
      case "tasks":
        return new TasksOverlayComponent({
          tasks: () => store.getSnapshot().tasks,
          roster: () => store.getSnapshot().roster,
          onClose: () => this.close(),
        })
      case "lineup":
        return new LineupOverlayComponent({
          store,
          onAddAgent: () => {
            this.close()
            runCommand("/agent")
          },
          onClose: () => this.close(),
        })
      case "presetPicker":
        return new PresetPickerOverlayComponent({
          presets: o.presets,
          store,
          onCancel: () => this.close(),
          onCompose: (preset, isNew) => {
            // The composer is Phase 4. Say so rather than swallow the keystroke:
            // `n` and the "＋ new" row look broken otherwise.
            this.close()
            store.pushNotice(
              `The preset composer lands in Phase 4 (${isNew ? "new roster" : `remix of "${preset.name}"`}).`,
              "error",
            )
          },
        })
      default:
        return null
    }
  }
}
