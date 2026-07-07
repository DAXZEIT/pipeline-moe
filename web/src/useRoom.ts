import { useEffect, useMemo, useSyncExternalStore } from "react"
import { createRoomStore } from "@pipeline-moe/client-core"
import { API_BASE } from "./api"

/**
 * React binding over the framework-agnostic room store. All the SSE state
 * machine, snapshot loading, and action logic now lives in
 * `@pipeline-moe/client-core`; this hook only wires that store to React's
 * external-store contract and ties its lifecycle to the component.
 *
 * The returned shape (state fields + action methods) is unchanged, so every
 * consuming component keeps working untouched.
 */
export function useRoom(roomId?: string) {
  // One store per room. App never remounts on room switch, so the store must be
  // recreated when roomId changes — otherwise REST calls would stay pinned to
  // the first room while SSE alone tracked the switch.
  const store = useMemo(() => createRoomStore({ apiBase: API_BASE, roomId }), [roomId])

  useEffect(() => {
    store.start()
    return () => store.stop()
  }, [store])

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)

  return { ...state, ...store.actions, pushNotice: store.pushNotice }
}
