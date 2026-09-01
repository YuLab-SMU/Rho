import { useCallback, useEffect, useState } from "react";

import type { EvidenceSubgraph } from "../../transport/evidence-graph";
import type { EvidenceGraphPorts } from "../workbench/evidenceGraphPorts";
import {
  authorityReferenceKey,
  useAuthorityProjection,
} from "../workbench/useAuthorityProjection";
import { SurfaceTaskState } from "../SurfaceTaskState";
import { workbenchFailureMessage } from "../workbench-failure";
import { EvidenceEdgeList } from "./EvidenceEdgeList";
import { EvidenceNodeCard } from "./EvidenceNodeCard";

export function EvidenceGraphSurface({ ports, rootNode, reportError }: {
  readonly ports: EvidenceGraphPorts;
  readonly rootNode: string | null;
  readonly reportError: (error: unknown) => void;
}) {
  const [graph, setGraph] = useState<EvidenceSubgraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      await ports.graph.refreshEvidenceGraph();
      let root = rootNode;
      if (root == null) root = (await ports.graph.listClaims({ limit: 1 })).items[0]?.node_id ?? null;
      if (root == null) {
        setGraph(null);
        setError(null);
        return;
      }
      setGraph(await ports.graph.getEvidenceSubgraph({ root_node: root, max_depth: 4, max_nodes: 200 }));
      setError(null);
    } catch (cause: unknown) {
      setError(workbenchFailureMessage(cause, "The Evidence Graph could not be loaded."));
    }
  }, [ports.graph, rootNode]);
  useEffect(() => { void load(); }, [load]);
  const authority = useAuthorityProjection(
    ports.authority,
    graph?.nodes.flatMap((node) => node.authority_ref == null ? [] : [node.authority_ref]) ?? [],
    reportError,
  );
  if (error != null) return <SurfaceTaskState tone="error" title="Evidence graph unavailable" detail={error} role="alert">
    <button type="button" onClick={() => void load().catch(reportError)}>Try again</button>
  </SurfaceTaskState>;
  if (graph == null) return <SurfaceTaskState tone="empty" title="No graph root" detail="Create or select a claim to inspect its graph neighborhood." role="status" />;
  return <section className="rho-evidence-surface">
    <header className="rho-evidence-toolbar"><div><strong>Evidence graph</strong><small>{graph.nodes.length} nodes · {graph.edges.length} links{graph.truncated ? " · bounded" : ""}</small></div><button type="button" onClick={() => void load()}>Refresh</button></header>
    <div className="rho-evidence-node-grid">{graph.nodes.map((node) => <EvidenceNodeCard
      node={node}
      selected={node.node_id === graph.root_node.node_id}
      key={node.node_id}
      authority={node.authority_ref == null
        ? null
        : authority.observations.get(authorityReferenceKey(node.authority_ref)) ?? null}
      authorityUnavailable={authority.unavailable}
    />)}</div>
    <EvidenceEdgeList edges={graph.edges} nodes={graph.nodes} />
  </section>;
}
