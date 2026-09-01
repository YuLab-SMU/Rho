import { useCallback, useEffect, useState } from "react";

import type {
  EvidenceGraphHealth,
  EvidenceNode,
} from "../../transport/evidence-graph";
import type { EvidenceGraphPorts } from "../workbench/evidenceGraphPorts";
import { SurfaceTaskState } from "../SurfaceTaskState";
import { workbenchFailureMessage } from "../workbench-failure";
import { ClaimTracePanel } from "./ClaimTracePanel";
import { EvidenceGraphHealth as HealthView } from "./EvidenceGraphHealth";
import { EvidenceNodeCard } from "./EvidenceNodeCard";

export function ClaimsSurface({ ports, initialClaimId, openTrace, reportError }: {
  readonly ports: EvidenceGraphPorts;
  readonly initialClaimId: string | null;
  readonly openTrace: (claimId: string) => void;
  readonly reportError: (error: unknown) => void;
}) {
  const [claims, setClaims] = useState<readonly EvidenceNode[]>([]);
  const [health, setHealth] = useState<EvidenceGraphHealth | null>(null);
  const [selected, setSelected] = useState<string | null>(initialClaimId);
  const [error, setError] = useState<string | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const nextHealth = await ports.graph.refreshEvidenceGraph();
      const page = await ports.graph.listClaims({ include_drafts: true, limit: 200 });
      setHealth(nextHealth);
      setClaims(page.items);
      setSelected((current) => current ?? page.items[0]?.node_id ?? null);
      setError(null);
    } catch (cause: unknown) {
      setError(workbenchFailureMessage(cause, "Claims could not be loaded."));
    }
  }, [ports.graph]);
  useEffect(() => { void load(); }, [load]);
  const create = async () => {
    if (!label.trim() || !summary.trim()) return;
    setBusy(true);
    try {
      const result = await ports.draft.createDraftClaim({
        label: label.trim(),
        summary: summary.trim(),
        claim_kind: "scientific_claim",
        data_class: "project_internal",
      });
      setLabel("");
      setSummary("");
      setDraftOpen(false);
      setSelected(result.record_id);
      await load();
    } catch (cause: unknown) {
      reportError(cause);
    } finally {
      setBusy(false);
    }
  };
  const promote = async (claim: EvidenceNode) => {
    if (health == null) return;
    setBusy(true);
    try {
      await ports.promotion.promoteDraft({
        record_kind: "node",
        record_id: claim.node_id,
        expected_graph_revision: health.graph_revision,
      });
      await load();
    } catch (cause: unknown) {
      reportError(cause);
    } finally {
      setBusy(false);
    }
  };
  return <section className="rho-evidence-surface rho-claims-surface">
    <header className="rho-evidence-toolbar">
      <HealthView health={health} />
      <div>
        <button type="button" onClick={() => setDraftOpen((value) => !value)}>{draftOpen ? "Cancel" : "Draft claim"}</button>
        <button type="button" disabled={busy} onClick={() => void ports.graph.refreshEvidenceGraph().then(load).catch(reportError)}>Refresh</button>
      </div>
    </header>
    {draftOpen && <form className="rho-claim-draft" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <label>Claim label<input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={512} /></label>
      <label>Summary<textarea value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={2_048} /></label>
      <button type="submit" disabled={busy || !label.trim() || !summary.trim()}>Create draft</button>
    </form>}
    {error != null && <SurfaceTaskState tone="error" title="Claims unavailable" detail={error} role="alert" />}
    {error == null && claims.length === 0 && <SurfaceTaskState tone="empty" title="No claims yet" detail="Create a draft claim, then explicitly promote it when its links are ready." role="status" />}
    {claims.length > 0 && <div className="rho-claims-layout">
      <div className="rho-evidence-node-grid">
        {claims.map((claim) => <div key={claim.node_id}>
          <EvidenceNodeCard node={claim} selected={selected === claim.node_id} onSelect={() => setSelected(claim.node_id)} />
          <div className="rho-evidence-row-actions">
            <button type="button" onClick={() => openTrace(claim.node_id)}>Open trace</button>
            {claim.promotion_state === "draft" && <button type="button" disabled={busy} onClick={() => void promote(claim)}>Promote</button>}
          </div>
        </div>)}
      </div>
      {selected != null && <ClaimTracePanel claimId={selected} ports={ports} reportError={reportError} />}
    </div>}
  </section>;
}
