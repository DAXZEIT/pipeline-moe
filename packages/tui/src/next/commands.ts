// Dispatching a slash command from the pi-tui client.
//
// `commands/registry.ts` (954 lines, 35 commands) is framework-free and does not
// change — it was written against a `CommandContext` of plain callbacks, so both
// clients dispatch the same code. All this module does is build that context out
// of the pi-tui client's pieces.
//
// As of Phase 5 the context is COMPLETE — all eleven overlay kinds are served and
// `switchRoom` rebinds the store for real. The `openOverlay` guard below stays
// anyway: it is what turns "the client cannot draw this yet" into a notice naming
// the phase rather than a silent no-op, and that is worth keeping for whatever
// overlay kind gets added next.

import type { Api, RoomStore } from "@pipeline-moe/client-core"
import type { CommandContext, Overlay } from "../commands/types"
import { lookup } from "../commands/registry"

export interface CommandRunnerDeps {
  /** Read at dispatch time, not captured: a room switch replaces the store, and a
   *  command that ran against the previous one would push its notices into a
   *  disposed store and mutate the room the user just left. */
  store: () => RoomStore
  api: Api
  /** Fresh state at dispatch time — a snapshot captured earlier can be a whole
   *  turn stale by the time a command with an await in it runs. */
  getState: () => ReturnType<RoomStore["getSnapshot"]>
  /** Overlays the client CAN raise. Returns false when it cannot, which is what
   *  makes the phase notice appear. */
  openOverlay?: (o: Overlay) => boolean
  closeOverlay?: () => void
  /** Switch rooms — hydrate-then-swap, so nothing flashes empty. */
  switchRoom: (roomId: string) => void
  /** A notice that must survive the store swap a switch performs. */
  notifyAfterSwitch: (message: string) => void
}

export function createCommandRunner(deps: CommandRunnerDeps): (input: string) => void {
  const { api, getState } = deps

  return (input: string): void => {
    const store = deps.store()
    const body = input.slice(1) // strip the leading "/"
    const sp = body.indexOf(" ")
    const head = sp === -1 ? body : body.slice(0, sp)
    const args = sp === -1 ? "" : body.slice(sp + 1)
    const cmd = lookup(head)
    if (!cmd) {
      store.pushNotice(`Unknown command: /${head}. Try /help.`, "error")
      return
    }
    const ctx: CommandContext = {
      store,
      api,
      state: getState(),
      notify: (m, l) => store.pushNotice(m, l),
      // A notice pushed in the same tick as a switch would land on the store
      // being disposed — park it and let the next store deliver it.
      notifyAfterSwitch: deps.notifyAfterSwitch,
      switchRoom: deps.switchRoom,
      openOverlay: (o) => {
        if (deps.openOverlay?.(o)) return
        store.pushNotice(`/${head}: this client cannot draw a ${o.kind} overlay yet.`, "error")
      },
      closeOverlay: () => deps.closeOverlay?.(),
    }
    Promise.resolve(cmd.run(ctx, args)).catch((err: unknown) => {
      store.pushNotice(err instanceof Error && err.message ? err.message : `/${head} failed.`, "error")
    })
  }
}
