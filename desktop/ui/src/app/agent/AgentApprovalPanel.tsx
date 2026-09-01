import type { AgentTurnDetail } from "../../transport";

type Approval = AgentTurnDetail["approvals"][number];

export function AgentApprovalPanel({ approvals, disabled, onDecision }: {
  readonly approvals: readonly Approval[];
  readonly disabled: boolean;
  readonly onDecision: (approval: Approval, decision: "approve" | "reject") => void;
}) {
  if (approvals.length === 0) return null;
  return <section aria-label="Approvals">
    <span className="rho-agent-section-label">Approvals</span>
    {approvals.map((approval) => <section className="rho-agent-approval" key={approval.request_id}>
      <header className="rho-agent-decision-header">
        <span className="rho-agent-decision-kind">Approval required</span>
        <strong>{approval.tool}</strong>
      </header>
      <pre>{approval.code ?? approval.arguments_json}</pre>
      <div className="rho-agent-decision-actions">
        <button type="button" disabled={disabled} onClick={() => onDecision(approval, "approve")}>Approve</button>
        <button type="button" disabled={disabled} onClick={() => onDecision(approval, "reject")}>Reject</button>
      </div>
    </section>)}
  </section>;
}
