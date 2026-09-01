import { useCallback, useEffect, useState } from "react";

import type { EvidenceGap, EvidenceGraphHealth } from "../../transport/evidence-graph";
import type { EvidenceGraphPorts } from "../workbench/evidenceGraphPorts";
import { SurfaceTaskState } from "../SurfaceTaskState";
import { workbenchFailureMessage } from "../workbench-failure";
import { EvidenceGraphHealth as HealthView } from "./EvidenceGraphHealth";

export function EvidenceGapsSurface({ ports, reportError }: {
  readonly ports: EvidenceGraphPorts;
  readonly reportError: (error: unknown) => void;
}) {
  const [gaps, setGaps] = useState<readonly EvidenceGap[]>([]);
  const [health, setHealth] = useState<EvidenceGraphHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const nextHealth = await ports.graph.refreshEvidenceGraph();
      const page = await ports.graph.listEvidenceGaps({ limit: 200 });
      setHealth(nextHealth);
      setGaps(page.items);
      setError(null);
    } catch (cause: unknown) {
      setError(workbenchFailureMessage(cause, "Evidence gaps could not be loaded."));
    }
  }, [ports.graph]);
  useEffect(() => { void load(); }, [load]);
  return <section className="rho-evidence-surface">
    <header className="rho-evidence-toolbar"><HealthView health={health} /><button type="button" onClick={() => void ports.graph.refreshEvidenceGraph().then(load).catch(reportError)}>Recompute</button></header>
    {error != null && <SurfaceTaskState tone="error" title="Evidence gaps unavailable" detail={error} role="alert" />}
    {error == null && gaps.length === 0 && <SurfaceTaskState tone="empty" title="No open evidence gaps" detail="Authority status and graph support are currently reconciled for the visible records." role="status" />}
    <ul className="rho-evidence-gap-list">{gaps.map((gap) => <li key={gap.gap_id}>
      <div><strong>{gap.rule_id.replaceAll("_", " ")}</strong><span>{gap.status}</span></div>
      {gap.basis.length > 0 && <dl>{gap.basis.map((fact) => <div key={fact.key}><dt>{fact.key.replaceAll("_", " ")}</dt><dd>{fact.value}</dd></div>)}</dl>}
      <small>graph revision {gap.detected_revision}</small>
    </li>)}</ul>
  </section>;
}
