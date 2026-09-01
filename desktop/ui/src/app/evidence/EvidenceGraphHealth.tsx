import type { EvidenceGraphHealth } from "../../transport/evidence-graph";

export function EvidenceGraphHealth({ health }: {
  readonly health: EvidenceGraphHealth | null;
}) {
  if (health == null) return <div className="rho-evidence-health" role="status">Reading graph health…</div>;
  return (
    <div
      className={`rho-evidence-health ${health.available ? "rho-evidence-health-ready" : "rho-evidence-health-unavailable"}`}
      role={health.available ? "status" : "alert"}
    >
      <span className="rho-status-dot" aria-hidden="true" />
      <strong>{health.available ? `${health.engine} graph ready` : "Evidence graph unavailable"}</strong>
      <span>graph r{health.graph_revision}</span>
      <span>authority cursor {health.authority_cursor}</span>
      {health.last_ingest_error_code != null && <span>ingest: {health.last_ingest_error_code}</span>}
      {health.message != null && <small>{health.message}</small>}
    </div>
  );
}
