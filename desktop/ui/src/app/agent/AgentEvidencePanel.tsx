import { useCallback, useEffect, useState } from "react";

import type {
  EvidenceGap,
  EvidenceGraphHealth,
  EvidenceSubgraph,
} from "../../transport/evidence-graph";
import type { AgentEvidencePorts } from "../workbench/evidenceGraphPorts";
import {
  authorityReferenceKey,
  useAuthorityProjection,
} from "../workbench/useAuthorityProjection";
import { AgentGapPanel } from "./AgentGapPanel";

import "../../styles/evidence-graph.css";

export function AgentEvidencePanel({ turnId, finalAnswer, ports, reportError }: {
  readonly turnId: string;
  readonly finalAnswer: string;
  readonly ports: AgentEvidencePorts;
  readonly reportError: (error: unknown) => void;
}) {
  const [graph, setGraph] = useState<EvidenceSubgraph | null>(null);
  const [gaps, setGaps] = useState<readonly EvidenceGap[]>([]);
  const [health, setHealth] = useState<EvidenceGraphHealth | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [drafted, setDrafted] = useState(false);
  const load = useCallback(async () => {
    const nextHealth = await ports.graph.getEvidenceGraphHealth();
    setHealth(nextHealth);
    if (!nextHealth.available) {
      setUnavailable(true);
      return;
    }
    try {
      const evidence = await ports.graph.listAgentTurnEvidence(turnId);
      const nodeIds = new Set(evidence.nodes.map((node) => node.node_id));
      const gapPage = await ports.graph.listEvidenceGaps({ limit: 200 });
      setGraph(evidence);
      setGaps(gapPage.items.filter((gap) => gap.subject_node == null || nodeIds.has(gap.subject_node)));
      setUnavailable(false);
    } catch {
      setGraph(null);
      setGaps([]);
      setUnavailable(true);
    }
  }, [ports.graph, turnId]);
  useEffect(() => { void load().catch(reportError); }, [load, reportError]);
  const draftConclusion = async () => {
    try {
      await ports.draft.createDraftClaim({
        label: `Agent conclusion ${turnId}`.slice(0, 512),
        summary: finalAnswer.slice(0, 2_048),
        claim_kind: "agent_conclusion",
        data_class: "project_internal",
      });
      setDrafted(true);
    } catch (cause: unknown) {
      reportError(cause);
    }
  };
  const cited = graph?.nodes.filter((node) => node.kind !== "agent_turn") ?? [];
  const authority = useAuthorityProjection(
    ports.authority,
    cited.flatMap((node) => node.authority_ref == null ? [] : [node.authority_ref]),
    reportError,
  );
  return <div className="rho-agent-evidence-composition">
    <section className="rho-agent-evidence-section">
      <div className="rho-agent-evidence-heading">
        <span className="rho-agent-section-label">Cited Evidence</span>
        <button type="button" disabled={drafted} onClick={() => void draftConclusion()}>{drafted ? "Drafted" : "Draft conclusion"}</button>
      </div>
      {unavailable && <p>Evidence is unavailable or this Agent turn has not reached the graph yet.</p>}
      {!unavailable && cited.length === 0 && <p>No cited graph record is linked to this answer.</p>}
      {cited.length > 0 && <ul>{cited.map((node) => <li key={node.node_id}>
        <strong>{node.label}</strong>
        {node.authority_ref == null
          ? <span>authority: not applicable</span>
          : <span>authority: {authority.unavailable
              ? "unavailable"
              : authority.observations.get(authorityReferenceKey(node.authority_ref))?.status
                ?? "resolving"}</span>}
        <span>graph: {node.promotion_state}</span>
      </li>)}</ul>}
    </section>
    <AgentGapPanel gaps={gaps} health={health} />
  </div>;
}
