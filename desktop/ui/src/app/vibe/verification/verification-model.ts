import type { CheckResult } from "../../../transport/check";
import type { EvidenceNode } from "../../../transport/evidence-graph";
import type {
  ArtifactRecordSummary,
  PlotArtifactSummary,
  PlotImageView,
  RunSummary,
} from "../../../transport/history";

export type VerificationReferenceKind =
  | "run"
  | "artifact"
  | "plot"
  | "check"
  | "evidence"
  | "finding";

export type VerificationReferenceOrigin =
  | { readonly kind: "page-block"; readonly pageId: string; readonly blockId: string }
  | { readonly kind: "surface"; readonly instanceId: string }
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "artifact"; readonly artifactId: string }
  | { readonly kind: "check"; readonly resultId: string }
  | { readonly kind: "evidence"; readonly claimId: string };

export interface VerificationExactReference {
  readonly kind: VerificationReferenceKind;
  readonly id: string;
  readonly label: string;
  readonly origin: VerificationReferenceOrigin;
}

export interface VerificationScope {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly projectRevision: number;
  readonly epoch: number;
}

export interface VerificationFocus extends VerificationScope {
  readonly pageId: string;
  readonly blockId: string | null;
  readonly references: readonly VerificationExactReference[];
}

export type VerificationLayout = "overview" | "focused" | "narrow";

export type VerificationSourceStatus = "unlinked" | "ready" | "failed" | "stale";

export type VerificationFailureCode =
  | "unavailable"
  | "contract-mismatch"
  | "stale-project";

export interface VerificationFailure {
  readonly code: VerificationFailureCode;
}

export interface VerificationResolvedRecord<T> {
  readonly record: T;
  readonly references: readonly VerificationExactReference[];
}

export interface VerificationSourceProjection<T> {
  readonly status: VerificationSourceStatus;
  readonly items: readonly T[];
  readonly unresolved: readonly VerificationExactReference[];
  readonly failure: VerificationFailure | null;
}

export type VerificationPlotPreview =
  | { readonly status: "ready"; readonly view: PlotImageView }
  | {
      readonly status: "failed";
      readonly reason:
        | "unavailable"
        | "id-mismatch"
        | "media-mismatch"
        | "unsupported-media"
        | "invalid-payload";
    }
  | { readonly status: "stale" };

export interface VerificationPlotRecord
  extends VerificationResolvedRecord<PlotArtifactSummary> {
  readonly preview: VerificationPlotPreview;
}

export type VerificationCheckRecord =
  | {
      readonly status: "ready";
      readonly result: CheckResult;
      readonly references: readonly VerificationExactReference[];
    }
  | {
      readonly status: "failed";
      readonly failure: VerificationFailure;
      readonly references: readonly VerificationExactReference[];
    }
  | {
      readonly status: "stale";
      readonly failure: VerificationFailure;
      readonly references: readonly VerificationExactReference[];
    };

export interface VerificationSnapshot extends VerificationScope {
  readonly focusKey: string;
  readonly pageId: string;
  readonly blockId: string | null;
  readonly invalidReferences: readonly VerificationExactReference[];
  readonly runs: VerificationSourceProjection<VerificationResolvedRecord<RunSummary>>;
  readonly artifacts: VerificationSourceProjection<
    VerificationResolvedRecord<ArtifactRecordSummary>
  >;
  readonly plots: VerificationSourceProjection<VerificationPlotRecord>;
  readonly checks: VerificationSourceProjection<VerificationCheckRecord>;
  readonly evidence: VerificationSourceProjection<
    VerificationResolvedRecord<EvidenceNode>
  >;
  readonly stale: boolean;
}

export type VerificationStudioTarget =
  | { readonly kind: "run"; readonly id: string }
  | { readonly kind: "check"; readonly id: string };

function originKey(origin: VerificationReferenceOrigin): readonly unknown[] {
  switch (origin.kind) {
    case "page-block":
      return [origin.kind, origin.pageId, origin.blockId];
    case "surface":
      return [origin.kind, origin.instanceId];
    case "run":
      return [origin.kind, origin.runId];
    case "artifact":
      return [origin.kind, origin.artifactId];
    case "check":
      return [origin.kind, origin.resultId];
    case "evidence":
      return [origin.kind, origin.claimId];
  }
}

export function verificationFocusKey(focus: VerificationFocus): string {
  return JSON.stringify([
    focus.projectId,
    focus.projectRoot,
    focus.projectRevision,
    focus.epoch,
    focus.pageId,
    focus.blockId,
    focus.references.map((reference) => [
      reference.kind,
      reference.id,
      reference.label,
      originKey(reference.origin),
    ]),
  ]);
}

export function checkNeedsCoverageWarning(result: CheckResult): boolean {
  return result.status === "incomplete"
    || result.status === "failed"
    || result.truncated
    || result.snapshot.truncated
    || result.coverage.files_skipped > 0
    || result.coverage.plugin_rule_failures > 0
    || result.limitations.length > 0
    || result.snapshot.limitations.length > 0;
}

export function runNeedsAttention(run: RunSummary): boolean {
  return run.status !== "completed";
}

export function plotStudioTarget(plot: PlotArtifactSummary): VerificationStudioTarget {
  return { kind: "run", id: plot.run_id };
}
