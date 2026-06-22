import { useEffect, useState } from "react"
import { Composer } from "./Composer"
import { ConversationBar } from "./ConversationBar"
import { RoutingApproval } from "./RoutingApproval"
import type { RoutingMode } from "../types"
import { PresetMenu } from "./PresetMenu"
import { ProvidersPanel } from "./ProvidersPanel"
import { Roster } from "./Roster"
import { RoomTabs } from "./RoomTabs"
import { Transcript } from "./Transcript"
import { SidePanel } from "./SidePanel"
import type { RoomSummary } from "../types"
import { useRoom } from "../useRoom"

interface Props {
  /** The room this view is bound to. App renders <RoomView key={roomId} …> so
   *  that switching rooms fully unmounts the old view — closing its SSE stream,
   *  dropping all state, and garbage-collecting every callback closure. This is
   *  what makes a tab a true "second page": no shared hook instance, no stale
   *  callback that could relaunch a turn in the wrong room. */
  roomId: string
  // Room-navigation chrome (RoomTabs) lives at the top of the center column, so
  // it is rendered here. These props are app-level state passed straight through.
  rooms: RoomSummary[]
  onSwitch: (roomId: string) => void
  onCreateRoom: () => void
  onDestroyRoom: (roomId: string) => void
  onStopRoom: (roomId: string) => void
  onRenameRoom: (roomId: string, name: string) => void
}

export function RoomView({
  roomId,
  rooms,
  onSwitch,
  onCreateRoom,
  onDestroyRoom,
  onStopRoom,
  onRenameRoom,
}: Props) {
  // The single source of room-scoped state. Bound to THIS RoomView instance,
  // which exists only while this room is active (key={roomId} in App).
  const room = useRoom(roomId)

  // Local draft for the hops field so typing doesn't fight the async server
  // round-trip; applied explicitly on Enter / blur / the ✓ button.
  const [hopsDraft, setHopsDraft] = useState(String(room.maxChainHops))
  useEffect(() => { setHopsDraft(String(room.maxChainHops)) }, [room.maxChainHops])
  const applyHops = () => {
    const parsed = parseInt(hopsDraft, 10)
    const n = Math.max(1, Math.min(100, Number.isFinite(parsed) ? parsed : room.maxChainHops))
    setHopsDraft(String(n))
    if (n !== room.maxChainHops) room.setMaxChainHops(n)
  }
  const hopsDirty = hopsDraft.trim() !== "" && Number(hopsDraft) !== room.maxChainHops

  return (
    <>
      <aside className="sidebar">
        <Roster
          roster={room.roster}
          connected={room.connected}
          defaultAgent={room.defaultAgent}
          turnActive={room.turnActive}
          onSetActive={room.setActive}
          onSetParallel={room.setParallel}
          onSetDefault={room.setDefaultAgent}
          onKick={room.kick}
          onCompact={room.compactAgent}
          onCreate={room.createParticipant}
          onAddTemplate={room.addFromTemplate}
          onReorder={room.reorderParticipants}
          onFetchParticipant={room.getParticipant}
          onUpdate={room.updateParticipant}
        />

        <ProvidersPanel
          providers={room.providers}
          _explicitlyEnabled={room.explicitlyEnabled}
          onAdd={room.addProvider}
          onRemove={room.removeProvider}
          onLogin={room.loginProvider}
        />
      </aside>

      <main className="center">
        <RoomTabs
          rooms={rooms}
          activeRoomId={roomId}
          onSwitch={onSwitch}
          onCreateRoom={onCreateRoom}
          onDestroyRoom={onDestroyRoom}
          onStopRoom={onStopRoom}
          onRenameRoom={onRenameRoom}
        />

        <header className="topbar">
          <span className="brand">Pipeline-MoE</span>
          <ConversationBar
            conversations={room.conversations}
            currentId={room.currentConversationId}
            turnActive={room.turnActive}
            onSwitch={room.loadConversation}
            onNew={room.newConversation}
            onRename={room.renameConversation}
            onDelete={room.deleteConversation}
          />
          <PresetMenu
            turnActive={room.turnActive}
            onSave={room.savePreset}
            onLoad={room.loadPreset}
            onApply={room.applyPreset}
          />
          <span className="topbar-sub">{room.turnActive ? "agents running…" : "ready"}</span>
          <div className="topbar-routing">
          <div
            className="mode-select"
            title="Routing: auto chains @mentions directly · semi asks before each wave's handoffs · manual asks per handoff"
          >
            {(["auto", "semi", "manual"] as RoutingMode[]).map((m) => (
              <button
                key={m}
                className={`mode-opt ${room.routingMode === m ? "on" : ""}`}
                onClick={() => room.setRoutingMode(m)}
              >
                {m}
              </button>
            ))}
          </div>
          {room.routingMode !== "manual" && (
            <label className="chain-hops" title="Max chain hops per turn (1–100). Enter or ✓ to apply.">
              hops
              <input
                type="number"
                min={1}
                max={100}
                value={hopsDraft}
                onChange={(e) => setHopsDraft(e.target.value)}
                onBlur={applyHops}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    applyHops()
                    ;(e.target as HTMLInputElement).blur()
                  }
                }}
              />
              {hopsDirty && (
                <button type="button" className="hops-apply" title="Apply hops" onMouseDown={(e) => e.preventDefault()} onClick={applyHops}>
                  ✓
                </button>
              )}
            </label>
          )}
          </div>
        </header>
        <Transcript
          messages={room.messages}
          streaming={room.streaming}
          liveActivity={room.liveActivity}
          liveReasoning={room.liveReasoning}
          receipts={room.receipts}
          roster={room.roster}
        />
        {room.pendingRoute && (
          <RoutingApproval
            proposals={room.pendingRoute}
            roster={room.roster}
            onResolve={room.resolveRoute}
          />
        )}
        <Composer
          roster={room.roster}
          turnActive={room.turnActive}
          runningAgentId={room.runningAgentId}
          paused={room.paused}
          pausedQuestion={room.pausedQuestion ?? null}
          pausedAskerId={room.pausedAskerId ?? null}
          onSend={room.send}
          onAbort={room.abort}
          onSteer={room.steer}
        />
      </main>

      <SidePanel
        files={room.workspace}
        turnActive={room.turnActive}
        onLoadPreset={room.loadPreset}
        onApplyPreset={room.applyPreset}
      />

      <div className="notices">
        {room.notices.map((n) => (
          <div key={n.id} className={`notice notice-${n.level}`}>
            {n.msg}
          </div>
        ))}
      </div>
    </>
  )
}
