import type { AgentTurnDetail, AgentTurnSummary } from "../../transport";

import { parseAgentFileProposal } from "./proposals";
import { agentTurnStatusLabel } from "./view-state";
import type { AgentSurfaceVm } from "./useAgentSurface";

function ApprovalStrip({ approval, onRespond }: {
  readonly approval: AgentTurnDetail["approvals"][number];
  readonly onRespond: (requestId: string, decision: "approve" | "reject") => void;
}) {
  return (
    <section className="rho-agent-approval">
      <header className="rho-agent-decision-header">
        <span className="rho-agent-decision-kind">Approval required</span>
        <strong>{approval.tool}</strong>
        <div className="rho-agent-decision-actions">
          <button type="button" onClick={() => onRespond(approval.request_id, "approve")}>Approve</button>
          <button type="button" onClick={() => onRespond(approval.request_id, "reject")}>Reject</button>
        </div>
      </header>
      <details className="rho-agent-approval-code">
        <summary>Code under review</summary>
        <pre>{approval.code ?? approval.arguments_json}</pre>
      </details>
    </section>
  );
}

function ActivityRows({ detail, excludeEventIds }: {
  readonly detail: AgentTurnDetail | undefined;
  readonly excludeEventIds: ReadonlySet<number>;
}) {
  const activityEvents = detail?.events.filter((event) =>
    (event.tool != null || event.code != null) && !excludeEventIds.has(event.id)) ?? [];
  const contextItems = detail?.context_items ?? [];
  if (activityEvents.length === 0 && contextItems.length === 0) return null;
  return (
    <div className="rho-agent-activity">
      {activityEvents.map((event) => event.code != null ? (
        <details className="rho-agent-code-review" key={event.id}>
          <summary>{event.title}</summary><pre>{event.code}</pre>
        </details>
      ) : (
        <div className="rho-agent-activity-row" key={event.id}>{event.title}</div>
      ))}
      {contextItems.length > 0 && <details className="rho-agent-context-used">
        <summary>Context used · {contextItems.length} {contextItems.length === 1 ? "source" : "sources"}</summary>
        <ol>{contextItems.map((item) => <li key={`${item.ordinal}:${item.source_kind}:${item.source_id ?? "current"}`}>
          <div><strong>{item.source_kind.replaceAll("_", " ")}</strong><span>{item.disposition}</span></div>
          {item.source_id != null && <code>{item.source_id}</code>}
          <small>{item.included_bytes.toLocaleString()} of {item.original_bytes.toLocaleString()} bytes · {item.trust_class}</small>
        </li>)}</ol>
      </details>}
    </div>
  );
}

export function AgentTurn({ turn, detail, vm }: {
  readonly turn: AgentTurnSummary;
  readonly detail: AgentTurnDetail | undefined;
  readonly vm: AgentSurfaceVm;
}) {
  const { pinTask, retryTurn, respondApproval, reportError, setFilesReviewOpen } = vm;
  const proposals = detail?.events.flatMap((event) => {
    const proposal = parseAgentFileProposal(event);
    return proposal == null ? [] : [{ event, proposal }];
  }) ?? [];
  const waitingApprovals = detail?.approvals.filter((approval) => approval.status === "waiting") ?? [];
  const proposalEventIds = new Set(proposals.map(({ event }) => event.id));
  return (
    <article className={`rho-agent-turn rho-agent-turn-${turn.status}`} data-turn-id={turn.turn_id}>
      <header>
        <strong>{turn.mode}</strong>
        {turn.status !== "completed" && <span className={`rho-agent-turn-status rho-agent-turn-status-${turn.status}`}>{agentTurnStatusLabel(turn.status)}</span>}
        <details className="rho-agent-turn-meta">
          <summary aria-label={`Details for ${turn.mode} turn`}>Details</summary>
          <div><span>Status</span><strong>{turn.status}</strong><span>Model</span><code>{turn.model}</code></div>
        </details>
      </header>
      <div className="rho-agent-goal">
        <p className="rho-agent-prompt">{turn.prompt_preview}</p>
      </div>
      {turn.final_message != null && <p className="rho-agent-answer">{turn.final_message}</p>}
      {turn.error_message != null && (
        <div className="rho-agent-turn-failure" role="alert">
          <strong>{turn.status === "cancelled"
            ? "Turn cancelled"
            : turn.status === "failed" ? "Turn failed" : "Turn ended with an error"}</strong>
          <p className="rho-agent-turn-error">{turn.error_message}</p>
        </div>
      )}
      {turn.status === "cancelled" && turn.error_message == null && (
        <p className="rho-agent-turn-cancelled">This turn was cancelled before completion. Retry runs it again.</p>
      )}
      {waitingApprovals.map((approval) => (
        <ApprovalStrip approval={approval} onRespond={respondApproval} key={approval.request_id} />
      ))}
      {proposals.length > 0 && (
        <button type="button" className="rho-agent-files-entry" onClick={() => setFilesReviewOpen(true)}>
          <span className="rho-agent-files-count">{proposals.length} {proposals.length === 1 ? "file" : "files"} changed</span>
          <code className="rho-agent-files-path">{proposals[0]!.proposal.path}{proposals.length > 1 ? ` +${proposals.length - 1} more` : ""}</code>
          <span className="rho-agent-files-review-link">Review</span>
        </button>
      )}
      <ActivityRows detail={detail} excludeEventIds={proposalEventIds} />
      <footer>
        <button type="button" onClick={() => void pinTask(turn).catch(reportError)}>Pin to Vibe</button>
        {(turn.status === "failed" || turn.status === "cancelled") && <button type="button" onClick={() => retryTurn(turn.turn_id)}>Retry</button>}
      </footer>
    </article>
  );
}
