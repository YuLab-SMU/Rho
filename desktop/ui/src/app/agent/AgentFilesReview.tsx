import { useMemo } from "react";

import { computeLineDiff } from "./diff";
import { proposalKey, type AgentProposalRef } from "./proposals";
import type { AgentSurfaceVm } from "./useAgentSurface";

function DiffView({ before, after }: {
  readonly before: string;
  readonly after: string;
}) {
  const diff = useMemo(() => computeLineDiff(before, after), [before, after]);
  if (diff == null) return (<>
    <p className="rho-agent-diff-note">This file is too large to diff here; showing the proposed content.</p>
    <pre>{after}</pre>
  </>);
  if (diff.hunks.length === 0) return <p className="rho-agent-diff-note">No line changes.</p>;
  return (
    <div className="rho-agent-diff" role="group" aria-label="Proposed diff">
      <div className="rho-agent-diff-summary">+{diff.additions} −{diff.removals}</div>
      {diff.hunks.map((hunk, hunkIndex) => (
        <div className="rho-agent-diff-hunk" key={hunkIndex}>
          {hunkIndex > 0 && <div className="rho-agent-diff-gap" aria-hidden="true">⋮</div>}
          <div className="rho-agent-diff-hunk-header">@@ -{hunk.beforeStart} +{hunk.afterStart} @@</div>
          <div className="rho-agent-diff-lines">{hunk.lines.map((line, lineIndex) => (
            <div className={`rho-agent-diff-line rho-agent-diff-${line.kind}`} key={lineIndex}>
              <span className="rho-agent-diff-sign" aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</span>
              <span className="rho-agent-diff-text">{line.text}</span>
            </div>
          ))}</div>
        </div>
      ))}
    </div>
  );
}

function ProposalDiff({ item, vm }: {
  readonly item: AgentProposalRef;
  readonly vm: AgentSurfaceVm;
}) {
  const { turn, event, proposal } = item;
  const key = proposalKey(turn.turn_id, event.id);
  const computable = proposal.operation === "append" || proposal.operation === "create";
  const diffState = vm.proposalDiffs.get(key);
  if (!computable) return (<>
    <p className="rho-agent-diff-note">This operation depends on the editor selection, so the final content can only be shown as the proposed content.</p>
    <pre>{proposal.content}</pre>
  </>);
  if (diffState == null) {
    // Not yet opened: keep the plain proposed-content view (and its text in
    // the DOM) until the user asks for the diff.
    return <pre>{proposal.content}</pre>;
  }
  if (diffState.status === "loading") {
    return <p className="rho-agent-diff-note">Loading current content…</p>;
  }
  if (diffState.status === "unavailable") return (<>
    <p className="rho-agent-diff-note">Current content is unavailable; showing the proposed content.</p>
    <pre>{proposal.content}</pre>
  </>);
  const after = proposal.operation === "append" ? diffState.before + proposal.content : proposal.content;
  return <DiffView before={diffState.before} after={after} />;
}

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
      <details className="rho-agent-file-content" onToggle={(toggleEvent) => {
        if (toggleEvent.currentTarget.open) void vm.loadProposalDiff(turn, event.id, proposal);
      }}>
        <summary onClick={() => void vm.loadProposalDiff(turn, event.id, proposal)}>Diff</summary>
        <ProposalDiff item={item} vm={vm} />
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
