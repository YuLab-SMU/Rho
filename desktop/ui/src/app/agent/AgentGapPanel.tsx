import type { EvidenceGap, EvidenceGraphHealth } from "../../transport/evidence-graph";

export function AgentGapPanel({ gaps, health }: {
  readonly gaps: readonly EvidenceGap[];
  readonly health: EvidenceGraphHealth | null;
}) {
  return <section className="rho-agent-evidence-section rho-agent-gap-panel">
    <span className="rho-agent-section-label">Gaps / Uncertainty</span>
    {health != null && !health.available && <p>Evidence unavailable: {health.error_code ?? "graph unavailable"}</p>}
    {health?.last_ingest_error_code != null && <p>Evidence ingest is lagging: {health.last_ingest_error_code}</p>}
    {health?.available && gaps.length === 0 && <p>No open graph gap is linked to this answer.</p>}
    {gaps.length > 0 && <ul>{gaps.map((gap) => <li key={gap.gap_id}>
      <strong>{gap.rule_id.replaceAll("_", " ")}</strong>
      <span>{gap.status}</span>
    </li>)}</ul>}
  </section>;
}
