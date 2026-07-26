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
// PHASE 4 IS WHERE THE STACK EARNS ITS KEEP.
//
// A form is not a picker. When the room form's Preset row raises the roster
// picker, the form must still be there behind it holding the name you typed — so
// forms get `push()`, which adds a layer, and `open()` keeps replacing for the
// registry. The composer goes three deep: roster → member card → model picker,
// and pi-tui hands focus back down one layer at a time on each hide. That is what
// deletes `RoomForm.tsx`'s `picking` flag and the composer's three `isActive &&
// !thatOtherThing` conjunctions rather than porting them.

import type { Component, Focusable, OverlayHandle, TUI } from "@earendil-works/pi-tui"
import type { Api, RoomStore } from "@pipeline-moe/client-core"
import type { Overlay } from "../commands/types"
import { ComposerComponent } from "./composer"
import { agentForm, editAgentForm, roomForm } from "./forms"
import { GraphOverlayComponent } from "./graph"
import { PromptOverlayComponent } from "./prompt"
import {
  LineupOverlayComponent,
  PresetPickerOverlayComponent,
  SelectOverlayComponent,
  TasksOverlayComponent,
  TextInputOverlayComponent,
} from "./overlays"

/** Every kind the registry can raise. Phase 5 closes the set: nothing falls
 *  through to a "lands in phase N" notice any more. */
const HANDLED = new Set<Overlay["kind"]>([
  "select",
  "textInput",
  "tasks",
  "lineup",
  "presetPicker",
  "agentForm",
  "editAgent",
  "roomForm",
  "presetComposer",
  "graph",
  "prompt",
])

const SIZE = { width: "80%", minWidth: 40, maxHeight: "80%", anchor: "center" } as const

export interface OverlayHostDeps {
  tui: TUI
  /** Read at build time, not captured: room switching replaces the store, and an
   *  overlay built against the previous one would edit the room the user left.
   *  (A switch also closes the stack — see `closeAll` — so this only has to be
   *  right at the moment an overlay is raised.) */
  store: () => RoomStore
  api: Api
  /** Where focus goes when the last overlay closes. */
  refocus: () => void
  /** Raise a command by name — `a` in the line-up opens the add-agent flow, and
   *  that flow is a registry command, not something this module should know. */
  runCommand: (input: string) => void
  /** A room was created: refresh the strip and switch to it. */
  onRoomCreated: (roomId: string, name: string, hadGoal: boolean) => void
  /** Release the terminal around a blocking child process and take it back —
   *  `/prompt`'s `e` hands the screen to $EDITOR. */
  suspend: (run: () => void) => void
}

interface Layer {
  handle: OverlayHandle
  /** The overlay's own cancel callback, so Esc and a programmatic close behave
   *  identically — a submenu that reopens its parent must do so either way. */
  onCancel: (() => void) | null
}

export class OverlayHost {
  private stack: Layer[] = []

  constructor(private deps: OverlayHostDeps) {}

  isOpen(): boolean {
    return this.stack.length > 0
  }

  /** Take the TOP overlay down without running its cancel callback. Used when
   *  something replaces it, and by an overlay that finished its job. */
  close(): void {
    const top = this.stack.pop()
    if (!top) return
    top.handle.hide()
    // pi-tui restores focus to the next visible overlay by itself; only an empty
    // stack needs telling where to go.
    if (this.stack.length === 0) this.deps.refocus()
    this.deps.tui.requestRender()
  }

  /** Every layer down, no cancel callbacks — a room switch is not a cancellation
   *  of the form you had open, it is the room changing under it. Callbacks here
   *  would reopen parents against a store that no longer exists. */
  closeAll(): void {
    while (this.stack.length > 0) this.close()
  }

  /** Esc, or /close-style dismissal: down it goes, and its cancel callback runs
   *  — that is what lets a submenu reopen the menu that raised it. */
  cancel(): void {
    const cb = this.stack[this.stack.length - 1]?.onCancel ?? null
    this.close()
    cb?.()
  }

  /** REGISTRY SEMANTICS: replace the top. See the module comment. */
  open(o: Overlay): boolean {
    if (!HANDLED.has(o.kind)) return false
    if (this.stack.length > 0) this.close()
    return this.push(o)
  }

  /** FORM SEMANTICS: a new layer, the caller still on screen underneath. */
  push(o: Overlay): boolean {
    if (!HANDLED.has(o.kind)) return false
    const component = this.build(o)
    if (!component) return false
    return this.mount(component, "onCancel" in o && o.onCancel ? o.onCancel : null) !== null
  }

  /** Push a component this host did not build — the member card, which is not one
   *  of the registry's overlay kinds. Returns the function that pops it. */
  pushComponent(component: Component & Focusable): () => void {
    const layer = this.mount(component, null)
    return () => {
      const i = this.stack.indexOf(layer)
      if (i === -1) return
      this.stack.splice(i, 1)
      layer.handle.hide()
      if (this.stack.length === 0) this.deps.refocus()
      this.deps.tui.requestRender()
    }
  }

  private mount(component: Component & Focusable, onCancel: (() => void) | null): Layer {
    // 80% wide, centred, capped at most of the screen. The conversation stays
    // visible around it, which is the point of an overlay rather than a screen.
    const handle = this.deps.tui.showOverlay(component, SIZE)
    const layer: Layer = { handle, onCancel }
    this.stack.push(layer)
    handle.focus()
    this.deps.tui.requestRender()
    return layer
  }

  /** The deps every form needs: push a picker on top of itself, pop itself, ask
   *  for a frame. `onClose` pops the layer the FORM is on, captured at build time
   *  — not "the top", which by then may be the picker the form just raised. */
  private formDeps(): { openPicker: (o: Overlay) => void; onClose: () => void; requestRender: () => void } {
    // The form's own layer does not exist yet when this is called (mount happens
    // after build), so `onClose` resolves it lazily by depth.
    const depth = this.stack.length
    return {
      openPicker: (o) => {
        this.push(o)
      },
      onClose: () => {
        while (this.stack.length > depth) this.close()
      },
      requestRender: () => this.deps.tui.requestRender(),
    }
  }

  private build(o: Overlay): (Component & Focusable) | null {
    const { api, runCommand } = this.deps
    const store = this.deps.store()
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
          // `n` on a preset, or ⏎ on the virtual "＋ new" row. `open` replaces the
          // picker rather than stacking on it: the composer is where you are
          // going, not a detail of the list you came from.
          onCompose: (preset, isNew) => this.open({ kind: "presetComposer", initial: preset, isNew }),
        })
      case "agentForm":
        return agentForm(store, this.formDeps())
      case "editAgent":
        return editAgentForm(o.agentId, store, this.formDeps())
      case "roomForm":
        return roomForm(api, { ...this.formDeps(), onCreated: this.deps.onRoomCreated })
      case "graph":
        return new GraphOverlayComponent({
          messages: () => store.getSnapshot().messages,
          roster: () => store.getSnapshot().roster,
          onClose: () => this.close(),
        })
      case "prompt":
        return new PromptOverlayComponent({
          agentId: o.agentId,
          store,
          onClose: () => this.close(),
          suspend: this.deps.suspend,
          requestRender: () => this.deps.tui.requestRender(),
        })
      case "presetComposer":
        return new ComposerComponent({
          initial: o.initial,
          isNew: o.isNew,
          api,
          store,
          deps: { ...this.formDeps(), openCard: (card) => this.pushComponent(card) },
        })
      default:
        return null
    }
  }
}
