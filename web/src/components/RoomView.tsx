
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
  /** The room this view is bound to. App keeps every open room's RoomView
   *  mounted (only the active one is shown), each with its own useRoom instance
   *  — distinct per roomId, so there's no shared hook and no stale callback that
   *  could relaunch a turn in the wrong room. Staying mounted keeps the SSE
   *  stream and in-flight streaming state alive when you peek at another room. */
  roomId: string
  /** Whether this is the room currently shown (the others are display:none). */
  active: boolean
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
  active,
  rooms,
  onSwitch,
  onCreateRoom,
  onDestroyRoom,
  onStopRoom,
  onRenameRoom,
}: Props) {
  // The single source of room-scoped state. Bound to THIS RoomView instance,
  // which stays mounted for the room's whole lifetime (App keeps all open rooms
  // mounted and toggles visibility), so its SSE + live state survive switches.
  const room = useRoom(roomId)

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

          </div>
        </header>
        <Transcript
          messages={room.messages}
          streaming={room.streaming}
          liveActivity={room.liveActivity}
          liveReasoning={room.liveReasoning}
          receipts={room.receipts}
          roster={room.roster}
          active={active}
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
          onShell={(cmd) => {
            // The transcript entry arrives over SSE when the command finishes;
            // surface transport/server failures as a notice instead of silence.
            room.runShell(cmd).catch((err: unknown) =>
              room.pushNotice(err instanceof Error && err.message ? err.message : "Shell failed.", "error"),
            )
          }}
        />
      </main>

      <SidePanel
        files={room.workspace}
        turnActive={room.turnActive}
        onLoadPreset={room.loadPreset}
        onApplyPreset={room.applyPreset}
        roster={room.roster}
        defaultAgent={room.defaultAgent}
        fallbackAgent={room.fallbackAgent}
        circuitBreaker={room.circuitBreaker}
        defaultThinkingLevel={room.defaultThinkingLevel}
        allowCloud={room.allowCloud}
        compactionReserveTokens={room.compactionReserveTokens}
        maxChainHops={room.maxChainHops}
        maxRooms={room.maxRooms}
        onSetDefaultAgent={room.setDefaultAgent}
        onSetFallbackAgent={room.setFallbackAgent}
        onSetCircuitBreaker={room.setCircuitBreaker}
        onSetDefaultThinkingLevel={room.setDefaultThinkingLevel}
        onSetAllowCloud={room.setAllowCloud}
        onSetCompactionReserveTokens={room.setCompactionReserveTokens}
        onSetMaxChainHops={room.setMaxChainHops}
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
