import type { EvidenceEdge, EvidenceNode } from "../../transport/evidence-graph";

export function EvidenceEdgeList({ edges, nodes }: {
  readonly edges: readonly EvidenceEdge[];
  readonly nodes: readonly EvidenceNode[];
}) {
  const labels = new Map(nodes.map((node) => [node.node_id, node.label]));
  if (edges.length === 0) return <p className="rho-evidence-empty-copy">No graph links in this view.</p>;
  return <ul className="rho-evidence-edges" aria-label="Evidence graph links">
    {edges.map((edge) => <li key={edge.edge_id}>
      <span className={`rho-evidence-polarity rho-evidence-polarity-${edge.polarity}`} aria-hidden="true" />
      <span>{labels.get(edge.from_node) ?? edge.from_node}</span>
      <strong>{edge.predicate.replaceAll("_", " ")}</strong>
      <span>{labels.get(edge.to_node) ?? edge.to_node}</span>
      <small>graph: {edge.promotion_state}{edge.provenance == null ? "" : ` · authority: ${edge.provenance.kind}`}</small>
    </li>)}
  </ul>;
}
