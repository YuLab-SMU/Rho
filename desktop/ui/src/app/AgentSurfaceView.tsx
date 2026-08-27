import "../styles/agent-surface.css";

import { AgentComposer, AgentRunningRow } from "./agent/AgentComposer";
import { AgentFilesReview } from "./agent/AgentFilesReview";
import { AgentTimeline } from "./agent/AgentTimeline";
import { AgentDegradedBanner, AgentToolbar } from "./agent/AgentToolbar";
import { useAgentSurface, type AgentSurfaceViewProps } from "./agent/useAgentSurface";

export type { AgentFileProposal, AgentFileUndoState } from "./agent/proposals";
export type { AgentSurfaceViewState } from "./agent/view-state";
export type { AgentSurfaceViewProps };

export function AgentSurfaceView(props: AgentSurfaceViewProps) {
  const vm = useAgentSurface(props);
  return (
    <section className={`rho-agent-surface rho-agent-${vm.displayMode}`}>
      <AgentDegradedBanner vm={vm} />
      <AgentToolbar vm={vm} conversations={vm.conversations} />
      {vm.displayMode === "activity" && vm.activeTurn != null && vm.stopActiveTurn != null && (
        <AgentRunningRow status={vm.activeTurn.status} startedAt={vm.activeTurn.started_at} onStop={vm.stopActiveTurn} />
      )}
      {vm.displayMode !== "composer" && <AgentFilesReview vm={vm} hidden={!vm.filesReviewOpen} />}
      {vm.displayMode !== "composer" && <AgentTimeline vm={vm} hidden={vm.filesReviewOpen} />}
      {vm.displayMode !== "activity" && <AgentComposer vm={vm} />}
    </section>
  );
}
