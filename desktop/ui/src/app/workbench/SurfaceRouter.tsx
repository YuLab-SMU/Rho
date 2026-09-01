import type { SurfaceInstance } from "../../transport";
import type { AuthorityPorts } from "./authorityPorts";
import type { EvidenceGraphPorts } from "./evidenceGraphPorts";
import type { ResultsPorts } from "./resultsPorts";
import { AUTHORITY_SURFACE_IDS, AuthoritySurfaceRouter } from "../authority";
import { EVIDENCE_SURFACE_IDS, EvidenceSurfaceRouter } from "../evidence";
import { RESULTS_SURFACE_IDS, ResultsSurfaceRouter } from "../results/ResultsSurfaceRouter";

export function SurfaceRouter({
  instance,
  authorityPorts,
  evidencePorts,
  resultsPorts,
  reportError,
  openSurface,
  openPlot,
}: {
  readonly instance: SurfaceInstance;
  readonly authorityPorts: AuthorityPorts;
  readonly evidencePorts: EvidenceGraphPorts;
  readonly resultsPorts: ResultsPorts;
  readonly reportError: (error: unknown) => void;
  readonly openSurface: (surfaceId: string, viewState?: unknown) => void;
  readonly openPlot: (plotId: string) => void;
}) {
  if (AUTHORITY_SURFACE_IDS.has(instance.surface_id)) {
    return <AuthoritySurfaceRouter
      instance={instance}
      ports={authorityPorts}
      reportError={reportError}
    />;
  }
  if (EVIDENCE_SURFACE_IDS.has(instance.surface_id)) {
    return <EvidenceSurfaceRouter
      instance={instance}
      ports={evidencePorts}
      reportError={reportError}
      openSurface={openSurface}
    />;
  }
  if (RESULTS_SURFACE_IDS.has(instance.surface_id)) {
    return <ResultsSurfaceRouter instance={instance} transport={resultsPorts} openPlot={openPlot} />;
  }
  return null;
}
