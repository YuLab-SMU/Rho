import { proposalKey, type AgentProposalRef } from "./proposals";
import type { AgentSurfaceVm } from "./useAgentSurface";

function ProposalRow({ item, vm }: {
  readonly item: AgentProposalRef;
  readonly vm: AgentSurfaceVm;
}) {
  const { turn, event, proposal } = item;
  const { view, busy, proposalOutcomeFor, applyProposal, rejectProposal, fileUndo, undoProposal } = vm;
  const key = proposalKey(turn.turn_id, event.id);
  const outcome = proposalOutcomeFor(turn, event.id);
  const rejected = view.file_decisions[key] === "rejected";
  return (
    <section className="rho-agent-file-proposal" data-proposal-key={key}>
      <header>
        <span className="rho-agent-decision-kind">File change</span>
        <strong>{proposal.operation.replaceAll("_", " ")}</strong>
        <code>{proposal.path}</code>
        {outcome != null && <span className="rho-agent-file-outcome">{outcome}</span>}
        {rejected && outcome == null && <span className="rho-agent-file-outcome">rejected in this view</span>}
        {outcome == null && !rejected && (
          <div className="rho-agent-decision-actions">
            <button type="button" disabled={busy || turn.status === "running" || turn.status === "waiting"} onClick={() => applyProposal(turn, event.id, proposal)}>Apply</button>
            <button type="button" onClick={() => rejectProposal(key)}>Reject</button>
          </div>
        )}
        {fileUndo?.turn_id === turn.turn_id && fileUndo.proposal_event_id === event.id && (
          <button type="button" disabled={busy} onClick={undoProposal}>Undo applied edit</button>
        )}
      </header>
      <details className="rho-agent-file-content">
        <summary>Proposed content</summary>
        <pre>{proposal.content}</pre>
      </details>
    </section>
  );
}

export function AgentFilesReview({ vm, hidden }: {
  readonly vm: AgentSurfaceVm;
  readonly hidden: boolean;
}) {
  const {
    busy, allProposals, pendingProposals,
    setFilesReviewOpen, applyAllProposals, rejectAllProposals,
  } = vm;
  return (
    <div className="rho-agent-files-review" aria-label="Review proposed file changes" hidden={hidden}>
      <header>
        <button type="button" className="rho-agent-review-back" onClick={() => setFilesReviewOpen(false)}>← Conversation</button>
        <strong>{allProposals.length} {allProposals.length === 1 ? "file" : "files"} changed</strong>
        <div className="rho-agent-review-batch">
          <button type="button" disabled={busy || pendingProposals.length === 0} onClick={() => void applyAllProposals()}>
            Apply all{pendingProposals.length > 0 ? ` (${pendingProposals.length})` : ""}
          </button>
          <button type="button" disabled={busy || pendingProposals.length === 0} onClick={rejectAllProposals}>Reject all</button>
        </div>
      </header>
      <p className="rho-agent-files-hint">Applying writes the proposed content to the project file. Batch actions cover the {pendingProposals.length} pending {pendingProposals.length === 1 ? "change" : "changes"}.</p>
      {allProposals.length === 0 ? (
        <p className="rho-agent-review-empty">No file changes were proposed in this conversation.</p>
      ) : (
        <ol className="rho-agent-review-list">
          {allProposals.map((item) => <ProposalRow item={item} vm={vm} key={proposalKey(item.turn.turn_id, item.event.id)} />)}
        </ol>
      )}
    </div>
  );
}
