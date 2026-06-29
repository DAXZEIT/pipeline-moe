import { Box } from "ink"
import { useEffect } from "react"
import type { RoomStore } from "@pipeline-moe/client-core"
import { useRoomStore } from "./useRoomStore"
import { Roster } from "./components/Roster"
import { Transcript } from "./components/Transcript"
import { StatusBar } from "./components/StatusBar"
import { Composer } from "./components/Composer"

export function App({ store }: { store: RoomStore }) {
  // Load the snapshot + open the SSE stream on mount; tear down on exit.
  useEffect(() => {
    store.start()
    return () => store.stop()
  }, [store])

  const state = useRoomStore(store)

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexGrow={1}>
        <Roster roster={state.roster} width={26} />
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          <Transcript messages={state.messages} roster={state.roster} streaming={state.streaming} maxLines={6} />
        </Box>
      </Box>
      <StatusBar
        connected={state.connected}
        turnActive={state.turnActive}
        runningAgentId={state.runningAgentId}
        routingMode={state.routingMode}
        roomId={store.roomId}
        messageCount={state.messages.length}
      />
      <Composer onSubmit={(text) => store.actions.send(text)} disabled={!state.connected} />
    </Box>
  )
}
