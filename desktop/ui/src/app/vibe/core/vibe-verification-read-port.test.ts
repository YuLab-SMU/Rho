import { describe, expect, it, vi } from "vitest";

import type { UiKernelSnapshot } from "../../../transport/kernel-generated";
import {
  VerificationStaleReadError,
  type VerificationScope,
} from "../verification";
import {
  makeArtifact,
  makeCheck,
  makeEvidence,
  makePlot,
  makePlotView,
  makeRun,
  TEST_PROJECT_ID,
  TEST_PROJECT_ROOT,
} from "../verification/verification-test-fixtures";
import {
  createVibeVerificationReadPort,
  VIBE_VERIFICATION_READ_LIMIT,
  type VibeVerificationReadFacets,
} from "./vibe-verification-read-port";

const scope: VerificationScope = {
  projectId: TEST_PROJECT_ID,
  projectRoot: TEST_PROJECT_ROOT,
  projectRevision: 12,
  epoch: 3,
};

function kernelSnapshot(overrides: {
  readonly projectId?: string;
  readonly projectRoot?: string;
  readonly projectRevision?: number;
} = {}): UiKernelSnapshot {
  return {
    contract: "rho.ui.kernel.snapshot.v1",
    contract_major: 1,
    snapshot_revision: 5,
    project: {
      project_id: overrides.projectId ?? scope.projectId,
      display_label: "scRNA atlas",
      display_path: overrides.projectRoot ?? scope.projectRoot,
    },
    context: {
      project_id: overrides.projectId ?? scope.projectId,
      project_revision: overrides.projectRevision ?? scope.projectRevision,
      scene_id: null,
      page_id: "page-method",
      focused_surface_instance_id: null,
      selection: null,
      workspace_health: "ready",
      agent_health: "ready",
      active_operations: [],
    },
    health: {
      workspace: { state: "ready", label: "Workspace R ready", detail: null },
      agent: { state: "ready", label: "Agent ready", detail: null },
    },
    command_registry: { registrations: [] },
  } satisfies UiKernelSnapshot;
}

function facets(overrides: Partial<VibeVerificationReadFacets> = {}) {
  let workbenchListener: (() => void) | null = null;
  let checkListener: (() => void) | null = null;
  const workbenchUnsubscribe = vi.fn();
  const checkUnsubscribe = vi.fn();
  const loadDomainSurface = vi.fn(async () => {
    throw new Error("The verification bridge must not read DomainSurfaceData.");
  });
  const loadSnapshot = vi.fn(async () => kernelSnapshot());
  const listRuns = vi.fn(async () => [
    makeRun({ run_id: "run-unrelated" }),
    makeRun(),
  ]);
  const listArtifactRecords = vi.fn(async () => [
    makeArtifact({ artifact_id: "artifact-unrelated" }),
    makeArtifact(),
    makeArtifact({ output_path: "outputs/duplicate.csv" }),
  ]);
  const listPlotArtifacts = vi.fn(async () => [
    makePlot({ plot_id: "plot-unrelated" }),
    makePlot(),
  ]);
  const listEvidenceClaims = vi.fn(async () => [
    makeEvidence({ claim_id: "claim-unrelated" }),
    makeEvidence(),
  ]);
  const loadCheckResult = vi.fn(async () => makeCheck());
  const readPlotArtifact = vi.fn(async () => makePlotView());
  const transport = {
    loadSnapshot,
    listRuns,
    listArtifactRecords,
    listPlotArtifacts,
    listEvidenceClaims,
    loadCheckResult,
    readPlotArtifact,
    subscribeWorkbenchInvalidated: vi.fn((listener: () => void) => {
      workbenchListener = listener;
      return workbenchUnsubscribe;
    }),
    subscribeCheckResultsInvalidated: vi.fn((listener: () => void) => {
      checkListener = listener;
      return checkUnsubscribe;
    }),
    loadDomainSurface,
    ...overrides,
  };
  return {
    transport,
    loadSnapshot,
    listRuns,
    listArtifactRecords,
    listPlotArtifacts,
    listEvidenceClaims,
    loadCheckResult,
    readPlotArtifact,
    workbenchUnsubscribe,
    checkUnsubscribe,
    loadDomainSurface,
    emitWorkbench: () => workbenchListener?.(),
    emitCheck: () => checkListener?.(),
  };
}

describe("Vibe typed verification read port", () => {
  it("reads the bounded typed facets, includes historical outputs and filters exact IDs without deduping", async () => {
    const fixture = facets();
    const port = createVibeVerificationReadPort({
      transport: fixture.transport,
      currentScope: () => scope,
    });

    await expect(port.readRuns(scope, ["run-18"])).resolves.toHaveLength(1);
    await expect(
      port.readArtifacts(scope, ["artifact-differential-expression"]),
    ).resolves.toHaveLength(2);
    await expect(port.readPlots(scope, ["plot-donor-consistency"])).resolves.toHaveLength(1);
    await expect(
      port.readEvidenceClaims(scope, ["claim-cluster-identity"]),
    ).resolves.toHaveLength(1);

    expect(fixture.transport.listRuns).toHaveBeenCalledWith(VIBE_VERIFICATION_READ_LIMIT);
    expect(fixture.transport.listArtifactRecords).toHaveBeenCalledWith(
      VIBE_VERIFICATION_READ_LIMIT,
      false,
    );
    expect(fixture.transport.listPlotArtifacts).toHaveBeenCalledWith(
      VIBE_VERIFICATION_READ_LIMIT,
      false,
    );
    expect(fixture.transport.listEvidenceClaims).toHaveBeenCalledWith(
      VIBE_VERIFICATION_READ_LIMIT,
    );
    expect(fixture.loadDomainSurface).not.toHaveBeenCalled();
  });

  it("uses exact typed Check and Plot requests", async () => {
    const fixture = facets();
    const port = createVibeVerificationReadPort({
      transport: fixture.transport,
      currentScope: () => scope,
    });

    await expect(port.readCheckResult(scope, "check-result-7")).resolves.toMatchObject({
      result_id: "check-result-7",
    });
    await expect(port.readPlot(scope, "plot-donor-consistency")).resolves.toMatchObject({
      plot_id: "plot-donor-consistency",
    });
    expect(fixture.transport.loadCheckResult).toHaveBeenCalledWith({
      project_id: scope.projectId,
      expected_project_revision: scope.projectRevision,
      result_id: "check-result-7",
    });
    expect(fixture.transport.readPlotArtifact).toHaveBeenCalledWith("plot-donor-consistency");
  });

  it.each([
    ["project identity", { projectId: "project:other" }],
    ["project root", { projectRoot: "/projects/other" }],
    ["project revision", { projectRevision: 13 }],
    ["local epoch", { epoch: 4 }],
  ] as const)("rejects a stale %s before reading", async (_label, mismatch) => {
    const fixture = facets();
    const port = createVibeVerificationReadPort({
      transport: fixture.transport,
      currentScope: () => ({ ...scope, ...mismatch }),
    });

    await expect(port.readRuns(scope, ["run-18"])).rejects.toBeInstanceOf(
      VerificationStaleReadError,
    );
    expect(fixture.transport.listRuns).not.toHaveBeenCalled();
  });

  it("rejects a project switch that lands while a typed read is in flight", async () => {
    const fixture = facets();
    fixture.loadSnapshot
      .mockResolvedValueOnce(kernelSnapshot())
      .mockResolvedValueOnce(kernelSnapshot({ projectRoot: "/projects/other" }));
    const port = createVibeVerificationReadPort({
      transport: fixture.transport,
      currentScope: () => scope,
    });

    await expect(port.readRuns(scope, ["run-18"])).rejects.toBeInstanceOf(
      VerificationStaleReadError,
    );
  });

  it("rejects an A-B-A local transition through the epoch even when backend identities match again", async () => {
    const fixture = facets();
    let current = scope;
    fixture.listRuns.mockImplementation(async () => {
      current = { ...scope, epoch: scope.epoch + 1 };
      return [makeRun()];
    });
    const port = createVibeVerificationReadPort({
      transport: fixture.transport,
      currentScope: () => current,
    });

    await expect(port.readRuns(scope, ["run-18"])).rejects.toBeInstanceOf(
      VerificationStaleReadError,
    );
  });

  it("preserves an ordinary typed-reader failure when the scope is still current", async () => {
    const unavailable = new Error("Run History extension unavailable");
    const fixture = facets({ listRuns: vi.fn(async () => { throw unavailable; }) });
    const port = createVibeVerificationReadPort({
      transport: fixture.transport,
      currentScope: () => scope,
    });

    await expect(port.readRuns(scope, ["run-18"])).rejects.toBe(unavailable);
    expect(fixture.loadSnapshot).toHaveBeenCalledTimes(2);
  });

  it("coalesces both invalidation sources in one microtask and fully unsubscribes", async () => {
    const fixture = facets();
    const port = createVibeVerificationReadPort({
      transport: fixture.transport,
      currentScope: () => scope,
    });
    const listener = vi.fn();
    const unsubscribe = port.subscribe(listener);

    fixture.emitWorkbench();
    fixture.emitCheck();
    expect(listener).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);

    fixture.emitCheck();
    unsubscribe();
    unsubscribe();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(fixture.workbenchUnsubscribe).toHaveBeenCalledTimes(1);
    expect(fixture.checkUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not invoke a typed source when its exact identity list is empty", async () => {
    const fixture = facets();
    const port = createVibeVerificationReadPort({
      transport: fixture.transport,
      currentScope: () => scope,
    });

    await expect(port.readRuns(scope, [])).resolves.toEqual([]);
    await expect(port.readArtifacts(scope, [])).resolves.toEqual([]);
    await expect(port.readPlots(scope, [])).resolves.toEqual([]);
    await expect(port.readEvidenceClaims(scope, [])).resolves.toEqual([]);
    expect(fixture.loadSnapshot).not.toHaveBeenCalled();
  });
});
