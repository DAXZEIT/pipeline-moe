import { Box, Text, useInput } from "ink"
import { useState } from "react"
import type { RoomStore } from "@pipeline-moe/client-core"
import { useRoomStore } from "../../useRoomStore"

/**
 * Interactive line-up editor. Reads the live roster from the store so reorder/
 * pause/kick reflect server confirmations as they arrive. All mutations go
 * through existing store actions — the overlay is pure UX.
 */
export function LineupOverlay({
  store,
  onAddAgent,
  onClose,
  isActive,
}: {
  store: RoomStore
  onAddAgent: () => void
  onClose: () => void
  isActive: boolean
}) {
  const state = useRoomStore(store)
  const roster = state.roster
  const [cursor, setCursor] = useState(0)
  const i = Math.min(cursor, Math.max(0, roster.length - 1))

  const move = (dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= roster.length) return
    const order = roster.map((p) => p.id)
    ;[order[i], order[j]] = [order[j], order[i]]
    store.actions.reorderParticipants(order)
    setCursor(j)
  }

  useInput(
    (input, key) => {
      if (key.escape) return onClose()
      if (input === "a") return onAddAgent()
      if (roster.length === 0) return
      const cur = roster[i]
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1))
      else if (key.downArrow) setCursor((c) => Math.min(roster.length - 1, c + 1))
      else if (input === "[") move(-1)
      else if (input === "]") move(1)
      else if (input === " ") store.actions.setActive(cur.id, !cur.active)
      else if (input === "p") store.actions.setParallel(cur.id, !cur.parallel)
      else if (input === "x") store.actions.kick(cur.id)
    },
    { isActive },
  )

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        Line-up ({roster.length})
      </Text>
      {roster.length === 0 ? (
        <Text dimColor>Empty room — press a to add an agent.</Text>
      ) : (
        roster.map((p, idx) => (
          <Box key={p.id}>
            <Text color={idx === i ? "cyan" : undefined} inverse={idx === i}>
              {idx === i ? "▶ " : "  "}
              <Text color={p.color}>
                {p.icon} {p.name}
              </Text>
              {"  "}
              {p.active ? "●active" : "○paused"}
              {p.parallel ? " ∥" : ""}
            </Text>
          </Box>
        ))
      )}
      <Text dimColor>↑↓ cursor · [ ] reorder · space pause · p parallel · x kick · a add · esc done</Text>
    </Box>
  )
}
