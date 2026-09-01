import { useCallback, useEffect, useState } from "react";

import type { ClaimTrace } from "../../transport/evidence-graph";
import type { EvidenceGraphPorts } from "../workbench/evidenceGraphPorts";
import {
  authorityReferenceKey,
  useAuthorityProjection,
} from "../workbench/useAuthorityProjection";
import { SurfaceTaskState } from "../SurfaceTaskState";
import { workbenchFailureMessage } from "../workbench-failure";
import { EvidenceEdgeList } from "./EvidenceEdgeList";
import { EvidenceNodeCard } from "./EvidenceNodeCard";

export function ClaimTracePanel({ claimId, ports, reportError }: {
  readonly claimId: string;
  readonly ports: EvidenceGraphPorts;
  readonly reportError: (error: unknown) => void;
}) {
  const [trace, setTrace] = useState<ClaimTrace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setTrace(await ports.graph.getClaimTrace(claimId));
      setError(null);
    } catch (cause: unknown) {
      setError(workbenchFailureMessage(cause, "This claim trace could not be loaded."));
    }
  }, [claimId, ports.graph]);
  useEffect(() => { void load(); }, [load]);
  const authority = useAuthorityProjection(
    ports.authority,
    trace?.authority_refs ?? [],
    reportError,
  );
  if (error != null) return <SurfaceTaskState tone="error" title="Claim trace unavailable" detail={error} role="alert">
    <button type="button" onClick={() => void load().catch(reportError)}>Try again</button>
  </SurfaceTaskState>;
  if (trace == null) return <SurfaceTaskState tone="loading" title="Loading claim trace…" detail="Reading typed graph projections." role="status" busy />;
  return <div className="rho-claim-trace">
    <EvidenceNodeCard
      node={trace.claim}
      authority={trace.claim.authority_ref == null
        ? null
        : authority.observations.get(authorityReferenceKey(trace.claim.authority_ref)) ?? null}
      authorityUnavailable={authority.unavailable}
    />
    <section>
      <h3>Linked records</h3>
      <div className="rho-evidence-node-grid">{trace.nodes.map((node) => <EvidenceNodeCard
        node={node}
        key={node.node_id}
        authority={node.authority_ref == null
          ? null
          : authority.observations.get(authorityReferenceKey(node.authority_ref)) ?? null}
        authorityUnavailable={authority.unavailable}
      />)}</div>
    </section>
    <section>
      <h3>Relationships</h3>
      <EvidenceEdgeList edges={trace.edges} nodes={[trace.claim, ...trace.nodes]} />
    </section>
    <section>
      <h3>Open gaps</h3>
      {trace.gaps.length === 0
        ? <p className="rho-evidence-empty-copy">No open gap is projected for this trace.</p>
        : <ul className="rho-evidence-gap-list">{trace.gaps.map((gap) => <li key={gap.gap_id}>
            <strong>{gap.rule_id.replaceAll("_", " ")}</strong>
            <span>{gap.status}</span>
          </li>)}</ul>}
    </section>
  </div>;
}
