import type { CheckResult } from "../../../transport/check";
import type { EvidenceClaim } from "../../../transport/evidence";
import type {
  ArtifactRecordSummary,
  PlotArtifactSummary,
  PlotImageView,
  RunSummary,
} from "../../../transport/history";
import {
  verificationFocusKey,
  type VerificationCheckRecord,
  type VerificationExactReference,
  type VerificationFailure,
  type VerificationFocus,
  type VerificationPlotPreview,
  type VerificationPlotRecord,
  type VerificationResolvedRecord,
  type VerificationScope,
  type VerificationSnapshot,
  type VerificationSourceProjection,
} from "./verification-model";
import {
  VerificationStaleReadError,
  type VerificationReadPort,
  type VerificationUnsubscribe,
} from "./verification-port";

const RASTER_PLOT_MEDIA_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

class VerificationContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationContractError";
  }
}

export interface VerificationAdapter {
  load(focus: VerificationFocus): Promise<VerificationSnapshot>;
  subscribe(listener: () => void): VerificationUnsubscribe;
}

type ReferenceGroups = ReadonlyMap<string, readonly VerificationExactReference[]>;

function scopeFromFocus(focus: VerificationFocus): VerificationScope {
  return {
    projectId: focus.projectId,
    projectRevision: focus.projectRevision,
    epoch: focus.epoch,
  };
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasValidOrigin(reference: VerificationExactReference): boolean {
  const origin = reference.origin;
  if (origin == null || typeof origin !== "object" || !("kind" in origin)) return false;
  switch (origin.kind) {
    case "page-block":
      return isNonEmpty(origin.pageId) && isNonEmpty(origin.blockId);
    case "surface":
      return isNonEmpty(origin.instanceId);
    case "run":
      return isNonEmpty(origin.runId);
    case "artifact":
      return isNonEmpty(origin.artifactId);
    case "check":
      return isNonEmpty(origin.resultId);
    case "evidence":
      return isNonEmpty(origin.claimId);
    default:
      return false;
  }
}

function isValidReference(reference: VerificationExactReference): boolean {
  return (
    reference.kind === "run"
    || reference.kind === "artifact"
    || reference.kind === "plot"
    || reference.kind === "check"
    || reference.kind === "evidence"
  ) && isNonEmpty(reference.id) && isNonEmpty(reference.label) && hasValidOrigin(reference);
}

function referencesByKind(
  focus: VerificationFocus,
  kind: VerificationExactReference["kind"],
): readonly VerificationExactReference[] {
  return focus.references.filter((reference) => isValidReference(reference) && reference.kind === kind);
}

function groupReferences(references: readonly VerificationExactReference[]): ReferenceGroups {
  const groups = new Map<string, VerificationExactReference[]>();
  for (const reference of references) {
    const existing = groups.get(reference.id);
    if (existing == null) groups.set(reference.id, [reference]);
    else existing.push(reference);
  }
  return groups;
}

function unlinkedSource<T>(): VerificationSourceProjection<T> {
  return { status: "unlinked", items: [], unresolved: [], failure: null };
}

function failureFrom(error: unknown): VerificationFailure {
  if (error instanceof VerificationStaleReadError) return { code: "stale-project" };
  if (error instanceof VerificationContractError) return { code: "contract-mismatch" };
  return { code: "unavailable" };
}

function failedSource<T>(
  references: readonly VerificationExactReference[],
  error: unknown,
): VerificationSourceProjection<T> {
  const failure = failureFrom(error);
  return {
    status: failure.code === "stale-project" ? "stale" : "failed",
    items: [],
    unresolved: references,
    failure,
  };
}

function sourceFromSettled<T>(
  settled: PromiseSettledResult<VerificationSourceProjection<T>>,
  references: readonly VerificationExactReference[],
): VerificationSourceProjection<T> {
  return settled.status === "fulfilled"
    ? settled.value
    : failedSource(references, settled.reason);
}

async function loadExactCollection<T>(
  scope: VerificationScope,
  references: readonly VerificationExactReference[],
  read: (ids: readonly string[]) => Promise<readonly T[]>,
  identity: (record: T) => string,
  project: (record: T) => string | null,
): Promise<VerificationSourceProjection<VerificationResolvedRecord<T>>> {
  if (references.length === 0) return unlinkedSource();
  const groups = groupReferences(references);
  const records = await read([...groups.keys()]);
  const exact = new Map<string, T>();
  for (const record of records) {
    const id = identity(record);
    if (!groups.has(id)) continue;
    if (exact.has(id)) {
      throw new VerificationContractError("The exact-reference reader returned a duplicate identity.");
    }
    const recordProject = project(record);
    if (recordProject != null && recordProject !== scope.projectId) {
      throw new VerificationStaleReadError();
    }
    exact.set(id, record);
  }
  const items: VerificationResolvedRecord<T>[] = [];
  const unresolved: VerificationExactReference[] = [];
  for (const [id, matchingReferences] of groups) {
    const record = exact.get(id);
    if (record == null) unresolved.push(...matchingReferences);
    else items.push({ record, references: matchingReferences });
  }
  return { status: "ready", items, unresolved, failure: null };
}

function isValidBase64(value: string): boolean {
  return value.length > 0
    && value.length % 4 !== 1
    && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function plotPreview(
  plot: PlotArtifactSummary,
  settled: PromiseSettledResult<PlotImageView>,
): VerificationPlotPreview {
  if (settled.status === "rejected") {
    return settled.reason instanceof VerificationStaleReadError
      ? { status: "stale" }
      : { status: "failed", reason: "unavailable" };
  }
  const view = settled.value;
  if (view.plot_id !== plot.plot_id) return { status: "failed", reason: "id-mismatch" };
  const recordMediaType = plot.media_type.toLowerCase();
  const viewMediaType = view.media_type.toLowerCase();
  if (!RASTER_PLOT_MEDIA_TYPES.has(recordMediaType)
    || !RASTER_PLOT_MEDIA_TYPES.has(viewMediaType)) {
    return { status: "failed", reason: "unsupported-media" };
  }
  if (recordMediaType !== viewMediaType) {
    return { status: "failed", reason: "media-mismatch" };
  }
  if (!isValidBase64(view.data_base64)) {
    return { status: "failed", reason: "invalid-payload" };
  }
  return { status: "ready", view };
}

async function loadPlots(
  port: VerificationReadPort,
  scope: VerificationScope,
  references: readonly VerificationExactReference[],
): Promise<VerificationSourceProjection<VerificationPlotRecord>> {
  const summaries = await loadExactCollection(
    scope,
    references,
    (ids) => port.readPlots(scope, ids),
    (record) => record.plot_id,
    (record) => record.project_root,
  );
  if (summaries.status !== "ready") {
    return {
      status: summaries.status,
      items: [],
      unresolved: summaries.unresolved,
      failure: summaries.failure,
    };
  }
  const previews = await Promise.allSettled(
    summaries.items.map(({ record }) => port.readPlot(scope, record.plot_id)),
  );
  const items = summaries.items.map((item, index): VerificationPlotRecord => ({
    ...item,
    preview: plotPreview(
      item.record,
      previews[index] ?? { status: "rejected", reason: new Error("Missing plot preview result.") },
    ),
  }));
  const stale = items.some((item) => item.preview.status === "stale");
  return {
    status: stale ? "stale" : "ready",
    items,
    unresolved: summaries.unresolved,
    failure: stale ? { code: "stale-project" } : null,
  };
}

function validateCheckResult(
  result: CheckResult,
  scope: VerificationScope,
  resultId: string,
): CheckResult {
  if (result.result_id !== resultId) {
    throw new VerificationContractError("The Check reader returned a different result identity.");
  }
  if (result.project_id !== scope.projectId
    || result.snapshot.project_id !== scope.projectId
    || result.project_revision !== scope.projectRevision
    || result.snapshot.project_revision !== scope.projectRevision) {
    throw new VerificationStaleReadError();
  }
  return result;
}

async function loadChecks(
  port: VerificationReadPort,
  scope: VerificationScope,
  references: readonly VerificationExactReference[],
): Promise<VerificationSourceProjection<VerificationCheckRecord>> {
  if (references.length === 0) return unlinkedSource();
  const groups = groupReferences(references);
  const entries = [...groups.entries()];
  const settled = await Promise.allSettled(
    entries.map(([resultId]) => port.readCheckResult(scope, resultId)
      .then((result) => validateCheckResult(result, scope, resultId))),
  );
  const items = entries.map(([, matchingReferences], index): VerificationCheckRecord => {
    const result = settled[index];
    if (result?.status === "fulfilled") {
      return { status: "ready", result: result.value, references: matchingReferences };
    }
    const failure = failureFrom(result?.reason);
    return failure.code === "stale-project"
      ? { status: "stale", failure, references: matchingReferences }
      : { status: "failed", failure, references: matchingReferences };
  });
  const stale = items.some((item) => item.status === "stale");
  return {
    status: stale ? "stale" : "ready",
    items,
    unresolved: [],
    failure: stale ? { code: "stale-project" } : null,
  };
}

function snapshotIsStale(
  sources: readonly VerificationSourceProjection<unknown>[],
): boolean {
  return sources.some((source) => source.status === "stale");
}

export function createVerificationAdapter(port: VerificationReadPort): VerificationAdapter {
  return {
    subscribe: (listener) => port.subscribe(listener),
    load: async (focus) => {
      const scope = scopeFromFocus(focus);
      const runReferences = referencesByKind(focus, "run");
      const artifactReferences = referencesByKind(focus, "artifact");
      const plotReferences = referencesByKind(focus, "plot");
      const checkReferences = referencesByKind(focus, "check");
      const evidenceReferences = referencesByKind(focus, "evidence");
      const invalidReferences = focus.references.filter((reference) => !isValidReference(reference));

      const [runsSettled, artifactsSettled, plotsSettled, checksSettled, evidenceSettled]
        = await Promise.allSettled([
          loadExactCollection(
            scope,
            runReferences,
            (ids) => port.readRuns(scope, ids),
            (record: RunSummary) => record.run_id,
            (record: RunSummary) => record.project_root,
          ),
          loadExactCollection(
            scope,
            artifactReferences,
            (ids) => port.readArtifacts(scope, ids),
            (record: ArtifactRecordSummary) => record.artifact_id,
            (record: ArtifactRecordSummary) => record.project_root,
          ),
          loadPlots(port, scope, plotReferences),
          loadChecks(port, scope, checkReferences),
          loadExactCollection(
            scope,
            evidenceReferences,
            (ids) => port.readEvidenceClaims(scope, ids),
            (record: EvidenceClaim) => record.claim_id,
            (record: EvidenceClaim) => record.project_root,
          ),
        ] as const);

      const runs = sourceFromSettled(runsSettled, runReferences);
      const artifacts = sourceFromSettled(artifactsSettled, artifactReferences);
      const plots = sourceFromSettled(plotsSettled, plotReferences);
      const checks = sourceFromSettled(checksSettled, checkReferences);
      const evidence = sourceFromSettled(evidenceSettled, evidenceReferences);

      return {
        ...scope,
        focusKey: verificationFocusKey(focus),
        pageId: focus.pageId,
        blockId: focus.blockId,
        invalidReferences,
        runs,
        artifacts,
        plots,
        checks,
        evidence,
        stale: snapshotIsStale([runs, artifacts, plots, checks, evidence]),
      };
    },
  };
}
