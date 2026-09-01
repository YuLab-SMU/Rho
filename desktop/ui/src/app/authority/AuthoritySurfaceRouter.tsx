import type { SurfaceInstance } from "../../transport";
import type { AuthorityPorts } from "../workbench/authorityPorts";
import { ApprovalsSurface } from "./ApprovalsSurface";
import { ArtifactsSurface } from "./ArtifactsSurface";
import { EnvironmentSurface } from "./EnvironmentSurface";
import { JobsSurface } from "./JobsSurface";
import { RevisionsSurface } from "./RevisionsSurface";
import { RunsSurface } from "./RunsSurface";

export const AUTHORITY_SURFACE_IDS = new Set([
  "rho.runs",
  "rho.jobs",
  "rho.artifacts",
  "rho.approvals",
  "rho.revisions",
  "rho.environment",
]);

export function AuthoritySurfaceRouter({ instance, ports, reportError }: {
  readonly instance: SurfaceInstance;
  readonly ports: AuthorityPorts;
  readonly reportError: (error: unknown) => void;
}) {
  switch (instance.surface_id) {
    case "rho.runs": return <RunsSurface transport={ports.facts} />;
    case "rho.jobs": return <JobsSurface transport={ports.facts} />;
    case "rho.artifacts": return <ArtifactsSurface transport={ports.facts} />;
    case "rho.approvals": return <ApprovalsSurface transport={ports.facts} />;
    case "rho.revisions": return <RevisionsSurface transport={ports.project} />;
    case "rho.environment":
      return <EnvironmentSurface
        instance={instance}
        transport={ports.environment}
        reportError={reportError}
      />;
    default: return null;
  }
}
