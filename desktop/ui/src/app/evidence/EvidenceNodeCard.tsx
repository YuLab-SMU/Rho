import type { EvidenceNode } from "../../transport/evidence-graph";
import type { AuthorityObservation } from "../../transport/authority";

export function EvidenceNodeCard({
  node,
  authority = null,
  authorityUnavailable = false,
  selected = false,
  onSelect,
}: {
  readonly node: EvidenceNode;
  readonly authority?: AuthorityObservation | null;
  readonly authorityUnavailable?: boolean;
  readonly selected?: boolean;
  readonly onSelect?: () => void;
}) {
  const content = <>
    <header>
      <span className={`rho-evidence-node-kind rho-evidence-node-kind-${node.kind}`}>{node.kind.replaceAll("_", " ")}</span>
      <strong>{node.label}</strong>
    </header>
    {node.summary != null && <p>{node.summary}</p>}
    <footer>
      <span>graph: {node.promotion_state} · {node.status}</span>
      {node.authority_ref != null && <span>authority: {authorityUnavailable
        ? "unavailable"
        : authority?.status ?? "resolving"}</span>}
      {authority?.digest != null && <code title={authority.digest}>digest verified</code>}
    </footer>
  </>;
  return onSelect == null
    ? <article className={`rho-evidence-node ${selected ? "rho-evidence-node-selected" : ""}`}>{content}</article>
    : <button
        type="button"
        className={`rho-evidence-node rho-evidence-node-button ${selected ? "rho-evidence-node-selected" : ""}`}
        onClick={onSelect}
      >{content}</button>;
}
