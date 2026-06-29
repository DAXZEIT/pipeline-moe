import { useCallback, useSyncExternalStore } from "react"
import type { RoomState, RoomStore } from "@pipeline-moe/client-core"

/**
 * Subscribe an Ink component to a room store, coalescing bursts of updates into
 * at most one render per `throttleMs`. Token streaming emits dozens of state
 * changes per second; without this, Ink would reconcile the whole layout on
 * every delta and flicker. getSnapshot always returns the latest state, so the
 * trailing render shows the final text — only intermediate frames are dropped.
 */
export function useRoomStore(store: RoomStore, throttleMs = 60): RoomState {
  const subscribe = useCallback(
    (onChange: () => void) => {
      let scheduled: ReturnType<typeof setTimeout> | null = null
      const unsub = store.subscribe(() => {
        if (scheduled) return
        scheduled = setTimeout(() => {
          scheduled = null
          onChange()
        }, throttleMs)
      })
      return () => {
        if (scheduled) clearTimeout(scheduled)
        unsub()
      }
    },
    [store, throttleMs],
  )
  return useSyncExternalStore(subscribe, store.getSnapshot)
}
