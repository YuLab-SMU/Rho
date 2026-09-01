import type { SurfaceInstance } from "../../transport";
import type { EvidenceGraphPorts } from "../workbench/evidenceGraphPorts";
import { ClaimTracePanel } from "./ClaimTracePanel";
import { ClaimsSurface } from "./ClaimsSurface";
import { EvidenceGapsSurface } from "./EvidenceGapsSurface";
import { EvidenceGraphSurface } from "./EvidenceGraphSurface";

import "../../styles/evidence-graph.css";

export const EVIDENCE_SURFACE_IDS = new Set([
  "rho.claims",
  "rho.evidence-graph",
  "rho.evidence-gaps",
  "rho.claim-trace",
]);

function viewState(instance: SurfaceInstance): Readonly<Record<string, unknown>> {
  return typeof instance.view_state === "object" && instance.view_state != null
    ? instance.view_state as Readonly<Record<string, unknown>>
    : {};
}

function selectedNode(instance: SurfaceInstance): string | null {
  const state = viewState(instance);
  for (const key of ["claim_id", "root_node", "selected_id"]) {
    if (typeof state[key] === "string" && state[key].trim()) return state[key];
  }
  return null;
}

export function EvidenceSurfaceRouter({ instance, ports, reportError, openSurface }: {
  readonly instance: SurfaceInstance;
  readonly ports: EvidenceGraphPorts;
  readonly reportError: (error: unknown) => void;
  readonly openSurface: (surfaceId: string, viewState?: unknown) => void;
}) {
  const selected = selectedNode(instance);
  switch (instance.surface_id) {
    case "rho.claims":
      return <ClaimsSurface
        ports={ports}
        initialClaimId={selected}
        openTrace={(claimId) => openSurface("rho.claim-trace", { claim_id: claimId })}
        reportError={reportError}
      />;
    case "rho.evidence-graph":
      return <EvidenceGraphSurface ports={ports} rootNode={selected} reportError={reportError} />;
    case "rho.evidence-gaps":
      return <EvidenceGapsSurface ports={ports} reportError={reportError} />;
    case "rho.claim-trace":
      return selected == null
        ? <section className="rho-evidence-surface"><p className="rho-evidence-empty-copy">This Claim Trace has no exact claim reference.</p></section>
        : <ClaimTracePanel claimId={selected} ports={ports} reportError={reportError} />;
    default:
      return null;
  }
}

export { ClaimTracePanel } from "./ClaimTracePanel";
export { ClaimsSurface } from "./ClaimsSurface";
export { EvidenceGapsSurface } from "./EvidenceGapsSurface";
export { EvidenceGraphSurface } from "./EvidenceGraphSurface";
