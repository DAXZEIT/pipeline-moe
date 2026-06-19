import { Composer } from "./components/Composer"
import { ConversationBar } from "./components/ConversationBar"
import { PresetMenu } from "./components/PresetMenu"
import { Roster } from "./components/Roster"
import { Transcript } from "./components/Transcript"
import { WorkspacePanel } from "./components/WorkspacePanel"
import { useRoom } from "./useRoom"

export default function App() {
  const room = useRoom()

  return (
    <div className="app">
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
        onReorder={room.reorderParticipants}
      />

      <main className="center">
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
          <PresetMenu turnActive={room.turnActive} />
          <span className="topbar-sub">{room.turnActive ? "agents running…" : "ready"}</span>
          <button
            className={`chain-toggle ${room.chaining ? "on" : ""}`}
            onClick={() => room.setChaining(!room.chaining)}
            title="When on, agents can summon each other via @mentions (no turn budget — use Stop to halt)"
          >
            ⟳ chaining {room.chaining ? "on" : "off"}
          </button>
        </header>
        <Transcript
          messages={room.messages}
          streaming={room.streaming}
          liveActivity={room.liveActivity}
          liveReasoning={room.liveReasoning}
          receipts={room.receipts}
          roster={room.roster}
        />
        <Composer
          roster={room.roster}
          turnActive={room.turnActive}
          runningAgentId={room.runningAgentId}
          onSend={room.send}
          onAbort={room.abort}
          onSteer={room.steer}
        />
      </main>

      <WorkspacePanel files={room.workspace} />

      <div className="notices">
        {room.notices.map((n) => (
          <div key={n.id} className={`notice notice-${n.level}`}>
            {n.msg}
          </div>
        ))}
      </div>
    </div>
  )
}
