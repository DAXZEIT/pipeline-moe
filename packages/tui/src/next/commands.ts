// Dispatching a slash command from the pi-tui client.
//
// `commands/registry.ts` (954 lines, 35 commands) is framework-free and does not
// change — it was written against a `CommandContext` of plain callbacks, so both
// clients dispatch the same code. All this module does is build that context out
// of the pi-tui client's pieces.
//
// Two callbacks are not fully honoured yet, and say so rather than failing
// silently:
//
//   - `openOverlay` — Phase 3 serves the five generic overlays (select,
//     textInput, tasks, lineup, presetPicker); the four forms are Phase 4 and
//     the graph and prompt pager are Phase 5. A command that raises one of those
//     posts a notice naming the phase. A silent no-op would read as a broken
//     command; an error would read as a bug. Naming the phase is the only honest
//     option while the client is half-migrated.
//   - `switchRoom` — needs the tab strip and store rebinding, which is Phase 5.
//
// Everything else works: the commands that act through the store or the API are
// the majority, and they are live from this phase on.

import type { Api, RoomStore } from "@pipeline-moe/client-core"
import type { CommandContext, Overlay } from "../commands/types"
import { lookup } from "../commands/registry"

/** Which phase of docs/tui-pitui-migration-plan.md brings each overlay. */
const OVERLAY_PHASE: Record<Overlay["kind"], string> = {
  select: "3",
  textInput: "3",
  lineup: "3",
  tasks: "3",
  presetPicker: "3",
  agentForm: "4",
  editAgent: "4",
  roomForm: "4",
  presetComposer: "4",
  graph: "5",
  prompt: "5",
}

export interface CommandRunnerDeps {
  store: RoomStore
  api: Api
  /** Fresh state at dispatch time — a snapshot captured earlier can be a whole
   *  turn stale by the time a command with an await in it runs. */
  getState: () => ReturnType<RoomStore["getSnapshot"]>
  /** Overlays the client CAN raise. Returns false when it cannot, which is what
   *  makes the phase notice appear. */
  openOverlay?: (o: Overlay) => boolean
  closeOverlay?: () => void
}

export function createCommandRunner(deps: CommandRunnerDeps): (input: string) => void {
  const { store, api, getState } = deps

  return (input: string): void => {
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
      // No room switching yet, so there is no store to outlive the notice —
      // it can go straight out. The Ink client has to park it (a notice pushed
      // in the same tick as a switch dies with the disposed store).
      notifyAfterSwitch: (m) => store.pushNotice(m),
      switchRoom: () => store.pushNotice("Room switching arrives with the tab strip (Phase 5).", "error"),
      openOverlay: (o) => {
        if (deps.openOverlay?.(o)) return
        store.pushNotice(`/${head}: the ${o.kind} overlay lands in Phase ${OVERLAY_PHASE[o.kind]}.`, "error")
      },
      closeOverlay: () => deps.closeOverlay?.(),
    }
    Promise.resolve(cmd.run(ctx, args)).catch((err: unknown) => {
      store.pushNotice(err instanceof Error && err.message ? err.message : `/${head} failed.`, "error")
    })
  }
}
