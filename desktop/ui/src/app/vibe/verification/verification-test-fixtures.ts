import type { CheckResult } from "../../../transport/check";
import type { EvidenceNode } from "../../../transport/evidence-graph";
import type {
  ArtifactRecordSummary,
  PlotArtifactSummary,
  PlotImageView,
  RunSummary,
} from "../../../transport/history";
import {
  verificationFocusKey,
  type VerificationExactReference,
  type VerificationFocus,
  type VerificationSnapshot,
  type VerificationSourceProjection,
} from "./verification-model";

export const TEST_PROJECT_ID = "project:sc-rna-atlas";
export const TEST_PROJECT_ROOT = "/projects/sc-rna-atlas";

export function makeReference(
  kind: VerificationExactReference["kind"],
  id: string,
  label = `${kind} reference`,
): VerificationExactReference {
  return {
    kind,
    id,
    label,
    origin: { kind: "page-block", pageId: "page-method", blockId: "block-cluster-contrast" },
  };
}

export function makeFocus(
  references: readonly VerificationExactReference[],
  overrides: Partial<VerificationFocus> = {},
): VerificationFocus {
  return {
    projectId: TEST_PROJECT_ID,
    projectRoot: TEST_PROJECT_ROOT,
    projectRevision: 12,
    epoch: 3,
    pageId: "page-method",
    blockId: "block-cluster-contrast",
    references,
    ...overrides,
  };
}

export function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: "run-18",
    parent_run_id: null,
    project_root: TEST_PROJECT_ROOT,
    origin: "agent",
    status: "completed",
    started_at: "2026-08-27T03:12:00Z",
    finished_at: "2026-08-27T03:14:12Z",
    terminal_reason: null,
    request_type: "source",
    operation_class: "read_only",
    source_path: "analysis/cluster_contrast.R",
    execution_mode: "source",
    document_version: 4,
    workspace_id: "workspace-sc-rna",
    state_revision_before: 20,
    project_revision_before: 11,
    state_revision_after: 21,
    project_revision_after: 12,
    environment_snapshot_id: "env-before",
    environment_snapshot_id_after: "env-after",
    code_preview: "fit <- glm(...)",
    error_message: null,
    ...overrides,
  };
}

export function makeArtifact(
  overrides: Partial<ArtifactRecordSummary> = {},
): ArtifactRecordSummary {
  return {
    artifact_id: "artifact-differential-expression",
    artifact_kind: "table",
    run_id: "run-18",
    project_root: TEST_PROJECT_ROOT,
    output_path: "outputs/cluster-3-vs-7/differential-expression.csv",
    source_path: "analysis/cluster_contrast.R",
    execution_mode: "source",
    document_version: 4,
    workspace_id: "workspace-sc-rna",
    state_revision: 21,
    project_revision: 12,
    media_type: "text/csv",
    metadata_json: "{}",
    provenance_complete: true,
    incomplete_reason: null,
    created_at: "2026-08-27T03:14:11Z",
    ...overrides,
  };
}

export function makePlot(overrides: Partial<PlotArtifactSummary> = {}): PlotArtifactSummary {
  return {
    plot_id: "plot-donor-consistency",
    run_id: "run-18",
    project_root: TEST_PROJECT_ROOT,
    source_path: "analysis/cluster_contrast.R",
    execution_mode: "source",
    document_version: 4,
    workspace_id: "workspace-sc-rna",
    state_revision: 21,
    project_revision: 12,
    media_type: "image/png",
    payload_json: "{}",
    provenance_complete: true,
    created_at: "2026-08-27T03:14:10Z",
    ...overrides,
  };
}

export function makePlotView(overrides: Partial<PlotImageView> = {}): PlotImageView {
  return {
    plot_id: "plot-donor-consistency",
    media_type: "image/png",
    data_base64: "aW1hZ2U=",
    ...overrides,
  };
}

export function makeEvidence(overrides: Partial<EvidenceNode> = {}): EvidenceNode {
  return {
    node_id: "claim-cluster-identity",
    kind: "claim",
    stable_key: "claim-cluster-identity",
    label: "Cluster contrast",
    summary: "Cluster 3 and cluster 7 differ in the recorded contrast output.",
    claim_kind: "scientific_claim",
    data_class: "project_internal",
    promotion_state: "promoted",
    status: "active",
    authority_ref: null,
    created_at: "2026-08-27T03:15:00Z",
    updated_at: "2026-08-27T03:15:00Z",
    ...overrides,
  };
}

export function makeCheck(overrides: Partial<CheckResult> = {}): CheckResult {
  const base: CheckResult = {
    contract: "rho.ui.check-result.v1",
    result_id: "check-result-7",
    project_id: TEST_PROJECT_ID,
    project_revision: 12,
    snapshot: {
      contract: "rho.ui.check-project.snapshot.v1",
      snapshot_id: "check-snapshot-7",
      project_id: TEST_PROJECT_ID,
      project_revision: 12,
      captured_at: "2026-08-27T03:16:00Z",
      files: [],
      source_bytes: 4096,
      renv_lock_sha256: null,
      truncated: false,
      limitations: [],
    },
    ruleset_digest: "ruleset-7",
    generated_at: "2026-08-27T03:16:02Z",
    status: "clean",
    findings: [],
    coverage: {
      files_scanned: 8,
      files_skipped: 0,
      core_rules: 12,
      plugin_rule_packs: 1,
      plugin_rule_failures: 0,
    },
    truncated: false,
    limitations: [],
  };
  return { ...base, ...overrides };
}

export function source<T>(
  items: readonly T[] = [],
  unresolved: readonly VerificationExactReference[] = [],
): VerificationSourceProjection<T> {
  return { status: "ready", items, unresolved, failure: null };
}

export function unlinkedSource<T>(): VerificationSourceProjection<T> {
  return { status: "unlinked", items: [], unresolved: [], failure: null };
}

export function makeSnapshot(
  focus: VerificationFocus,
  overrides: Partial<VerificationSnapshot> = {},
): VerificationSnapshot {
  return {
    projectId: focus.projectId,
    projectRoot: focus.projectRoot,
    projectRevision: focus.projectRevision,
    epoch: focus.epoch,
    pageId: focus.pageId,
    blockId: focus.blockId,
    focusKey: verificationFocusKey(focus),
    invalidReferences: [],
    runs: unlinkedSource(),
    artifacts: unlinkedSource(),
    plots: unlinkedSource(),
    checks: unlinkedSource(),
    evidence: unlinkedSource(),
    stale: false,
    ...overrides,
  };
}
