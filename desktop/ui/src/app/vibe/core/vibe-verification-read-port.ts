import type { CheckTransport } from "../../../transport/check";
import type { EvidenceGraphReadTransport } from "../../../transport/evidence-graph";
import type { HistoryReadTransport } from "../../../transport/history";
import type { KernelTransport } from "../../../transport/kernel-generated";
import type { WorkbenchProjectionTransport } from "../../../transport/workbench-projection";
import {
  VerificationStaleReadError,
  type VerificationReadPort,
  type VerificationScope,
  type VerificationUnsubscribe,
} from "../verification";

export const VIBE_VERIFICATION_READ_LIMIT = 100;

export type VibeVerificationReadFacets =
  & Pick<
    HistoryReadTransport,
    | "listRuns"
    | "listArtifactRecords"
    | "listPlotArtifacts"
    | "readPlotArtifact"
  >
  & Pick<EvidenceGraphReadTransport, "listClaims">
  & Pick<CheckTransport, "loadCheckResult">
  & Pick<KernelTransport, "loadSnapshot">
  & Pick<WorkbenchProjectionTransport, "subscribeWorkbenchInvalidated">
  & {
    subscribeCheckResultsInvalidated(listener: () => void): VerificationUnsubscribe;
  };

export interface VibeVerificationReadPortOptions {
  readonly transport: VibeVerificationReadFacets;
  /**
   * Returns the integration controller's current local epoch. The backend
   * snapshot cannot detect an A -> B -> A Page or project transition on its
   * own, so both authorities are checked before and after every read.
   */
  readonly currentScope: () => VerificationScope | null;
}

function scopesMatch(
  expected: VerificationScope,
  current: VerificationScope | null,
): boolean {
  return current != null
    && current.projectId === expected.projectId
    && current.projectRoot === expected.projectRoot
    && current.projectRevision === expected.projectRevision
    && current.epoch === expected.epoch;
}

function assertLocalScope(
  expected: VerificationScope,
  currentScope: () => VerificationScope | null,
): void {
  if (!scopesMatch(expected, currentScope())) throw new VerificationStaleReadError();
}

async function assertCurrentScope(
  expected: VerificationScope,
  options: VibeVerificationReadPortOptions,
): Promise<void> {
  assertLocalScope(expected, options.currentScope);
  const snapshot = await options.transport.loadSnapshot();
  if (
    snapshot.project.project_id !== expected.projectId
    || snapshot.project.display_path !== expected.projectRoot
    || snapshot.context.project_revision !== expected.projectRevision
  ) {
    throw new VerificationStaleReadError();
  }
  assertLocalScope(expected, options.currentScope);
}

async function guardedRead<T>(
  scope: VerificationScope,
  options: VibeVerificationReadPortOptions,
  read: () => Promise<T>,
): Promise<T> {
  await assertCurrentScope(scope, options);
  let result: T;
  try {
    result = await read();
  } catch (error) {
    if (error instanceof VerificationStaleReadError) throw error;
    try {
      await assertCurrentScope(scope, options);
    } catch (scopeError) {
      if (scopeError instanceof VerificationStaleReadError) throw scopeError;
    }
    throw error;
  }
  await assertCurrentScope(scope, options);
  return result;
}

function exactRecords<T>(
  records: readonly T[],
  ids: readonly string[],
  identity: (record: T) => string,
): readonly T[] {
  const requested = new Set(ids);
  return records.filter((record) => requested.has(identity(record)));
}

function mergedInvalidationSubscription(
  transport: VibeVerificationReadFacets,
  listener: () => void,
): VerificationUnsubscribe {
  let active = true;
  let queued = false;
  const unsubscriptions: VerificationUnsubscribe[] = [];
  const schedule = () => {
    if (!active || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (active) listener();
    });
  };
  try {
    unsubscriptions.push(transport.subscribeWorkbenchInvalidated(schedule));
    unsubscriptions.push(transport.subscribeCheckResultsInvalidated(schedule));
  } catch (error) {
    active = false;
    for (const unsubscribe of unsubscriptions.splice(0)) unsubscribe();
    throw error;
  }
  return () => {
    if (!active) return;
    active = false;
    queued = false;
    for (const unsubscribe of unsubscriptions.splice(0)) unsubscribe();
  };
}

export function createVibeVerificationReadPort(
  options: VibeVerificationReadPortOptions,
): VerificationReadPort {
  const { transport } = options;
  return {
    readRuns: async (scope, runIds) => {
      if (runIds.length === 0) return [];
      const records = await guardedRead(
        scope,
        options,
        () => transport.listRuns(VIBE_VERIFICATION_READ_LIMIT),
      );
      return exactRecords(records, runIds, (record) => record.run_id);
    },
    readArtifacts: async (scope, artifactIds) => {
      if (artifactIds.length === 0) return [];
      const records = await guardedRead(
        scope,
        options,
        () => transport.listArtifactRecords(VIBE_VERIFICATION_READ_LIMIT, false),
      );
      return exactRecords(records, artifactIds, (record) => record.artifact_id);
    },
    readPlots: async (scope, plotIds) => {
      if (plotIds.length === 0) return [];
      const records = await guardedRead(
        scope,
        options,
        () => transport.listPlotArtifacts(VIBE_VERIFICATION_READ_LIMIT, false),
      );
      return exactRecords(records, plotIds, (record) => record.plot_id);
    },
    readEvidenceClaims: async (scope, claimIds) => {
      if (claimIds.length === 0) return [];
      const records = await guardedRead(
        scope,
        options,
        async () => (await transport.listClaims({ limit: VIBE_VERIFICATION_READ_LIMIT })).items,
      );
      return exactRecords(records, claimIds, (record) => record.node_id);
    },
    readCheckResult: (scope, resultId) => guardedRead(
      scope,
      options,
      () => transport.loadCheckResult({
        project_id: scope.projectId,
        expected_project_revision: scope.projectRevision,
        result_id: resultId,
      }),
    ),
    readPlot: (scope, plotId) => guardedRead(
      scope,
      options,
      () => transport.readPlotArtifact(plotId),
    ),
    subscribe: (listener) => mergedInvalidationSubscription(transport, listener),
  };
}
