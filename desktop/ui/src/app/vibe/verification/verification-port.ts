import type { CheckResult } from "../../../transport/check";
import type { EvidenceNode } from "../../../transport/evidence-graph";
import type {
  ArtifactRecordSummary,
  PlotArtifactSummary,
  PlotImageView,
  RunSummary,
} from "../../../transport/history";
import type { VerificationScope } from "./verification-model";

export type VerificationUnsubscribe = () => void;

/**
 * A narrow, typed boundary for the verification region. Implementations must
 * resolve only the supplied identities in the supplied project epoch. The
 * generic DomainSurfaceData.detail projection is intentionally absent.
 * Exact stale/CAS rejections must be translated to VerificationStaleReadError;
 * the view adapter deliberately does not guess staleness from error strings.
 */
export interface VerificationReadPort {
  readRuns(
    scope: VerificationScope,
    runIds: readonly string[],
  ): Promise<readonly RunSummary[]>;
  readArtifacts(
    scope: VerificationScope,
    artifactIds: readonly string[],
  ): Promise<readonly ArtifactRecordSummary[]>;
  readPlots(
    scope: VerificationScope,
    plotIds: readonly string[],
  ): Promise<readonly PlotArtifactSummary[]>;
  readEvidenceClaims(
    scope: VerificationScope,
    claimIds: readonly string[],
  ): Promise<readonly EvidenceNode[]>;
  readCheckResult(scope: VerificationScope, resultId: string): Promise<CheckResult>;
  readPlot(scope: VerificationScope, plotId: string): Promise<PlotImageView>;
  subscribe(listener: () => void): VerificationUnsubscribe;
}

export class VerificationStaleReadError extends Error {
  constructor(message = "The verification project epoch is stale.") {
    super(message);
    this.name = "VerificationStaleReadError";
  }
}
