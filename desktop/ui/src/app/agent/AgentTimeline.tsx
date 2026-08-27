import { AGENT_SUGGESTIONS } from "./view-state";
import { AgentTurn } from "./AgentTurn";
import type { AgentSurfaceVm } from "./useAgentSurface";

export function AgentTimeline({ vm, hidden }: {
  readonly vm: AgentSurfaceVm;
  readonly hidden: boolean;
}) {
  const { view, commitView, loading, turns } = vm;
  return (
    <div className="rho-agent-timeline" aria-busy={loading} hidden={hidden}>
      {loading && <p className="rho-agent-loading">Loading conversation…</p>}
      {!loading && turns.length === 0 && <div className="rho-agent-empty" role="status">
        <strong>{view.conversation_id == null ? "No conversation yet" : "Ready for the first turn"}</strong>
        <span>{view.conversation_id == null
          ? "Write below and send; Rho opens a conversation and keeps the thread, run state, and decisions here."
          : "Choose Ask, Plan, or Act, then use the composer below."}</span>
        <div className="rho-agent-suggestions">
          {AGENT_SUGGESTIONS.map((suggestion) => (
            <button type="button" key={suggestion} onClick={() => commitView({ ...view, composer: suggestion }, false)}>
              {suggestion}
            </button>
          ))}
        </div>
      </div>}
      {turns.map((turn) => (
        <AgentTurn turn={turn} detail={vm.details.get(turn.turn_id)} vm={vm} key={turn.turn_id} />
      ))}
    </div>
  );
}
