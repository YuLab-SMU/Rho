import { describe, expect, it, vi } from "vitest";

import type { VerificationReadPort } from "./verification-port";
import { createVerificationAdapter } from "./verification-adapter";
import {
  makeArtifact,
  makeCheck,
  makeEvidence,
  makeFocus,
  makePlot,
  makePlotView,
  makeReference,
  makeRun,
  TEST_PROJECT_ID,
  TEST_PROJECT_ROOT,
} from "./verification-test-fixtures";

function makePort(overrides: Partial<VerificationReadPort> = {}): VerificationReadPort {
  return {
    readRuns: async () => [],
    readArtifacts: async () => [],
    readPlots: async () => [],
    readEvidenceClaims: async () => [],
    readCheckResult: async () => makeCheck(),
    readPlot: async () => makePlotView(),
    subscribe: () => () => undefined,
    ...overrides,
  };
}

describe("typed verification adapter", () => {
  it("projects only explicit identities and preserves unresolved references", async () => {
    const readRuns = vi.fn(async () => [
      makeRun({ run_id: "recent-but-unlinked" }),
      makeRun(),
    ]);
    const readArtifacts = vi.fn(async () => [
      makeArtifact({ artifact_id: "unlinked-artifact" }),
      makeArtifact(),
    ]);
    const readEvidenceClaims = vi.fn(async () => [
      makeEvidence(),
      makeEvidence({ claim_id: "unlinked-claim" }),
    ]);
    const port = makePort({ readRuns, readArtifacts, readEvidenceClaims });
    const focus = makeFocus([
      makeReference("run", "run-18", "Contrast execution"),
      makeReference("artifact", "artifact-differential-expression", "Differential-expression table"),
      makeReference("artifact", "missing-artifact", "Donor consistency report"),
      makeReference("evidence", "claim-cluster-identity", "Cluster identity claim link"),
    ]);

    const snapshot = await createVerificationAdapter(port).load(focus);

    expect(readRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: TEST_PROJECT_ID,
        projectRoot: TEST_PROJECT_ROOT,
        projectRevision: 12,
        epoch: 3,
      }),
      ["run-18"],
    );
    expect(readArtifacts).toHaveBeenCalledWith(expect.any(Object), [
      "artifact-differential-expression",
      "missing-artifact",
    ]);
    expect(snapshot.runs.items.map(({ record }) => record.run_id)).toEqual(["run-18"]);
    expect(snapshot.artifacts.items.map(({ record }) => record.artifact_id)).toEqual([
      "artifact-differential-expression",
    ]);
    expect(snapshot.artifacts.unresolved.map(({ label }) => label)).toEqual([
      "Donor consistency report",
    ]);
    expect(snapshot.evidence.items.map(({ record }) => record.claim_id)).toEqual([
      "claim-cluster-identity",
    ]);
  });

  it("isolates a failed source with Promise.allSettled", async () => {
    const port = makePort({
      readArtifacts: async () => [makeArtifact()],
      readEvidenceClaims: async () => { throw new Error("evidence backend unavailable"); },
    });
    const focus = makeFocus([
      makeReference("artifact", "artifact-differential-expression", "DE table"),
      makeReference("evidence", "claim-cluster-identity", "Evidence link"),
    ]);

    const snapshot = await createVerificationAdapter(port).load(focus);

    expect(snapshot.artifacts.status).toBe("ready");
    expect(snapshot.artifacts.items).toHaveLength(1);
    expect(snapshot.evidence.status).toBe("failed");
    expect(snapshot.evidence.failure).toEqual({ code: "unavailable" });
    expect(snapshot.stale).toBe(false);
  });

  it("rejects cross-project records as a stale project epoch", async () => {
    const port = makePort({
      readRuns: async () => [makeRun({ project_root: "/projects/other" })],
    });
    const focus = makeFocus([makeReference("run", "run-18", "Contrast execution")]);

    const snapshot = await createVerificationAdapter(port).load(focus);

    expect(snapshot.runs.status).toBe("stale");
    expect(snapshot.runs.items).toEqual([]);
    expect(snapshot.stale).toBe(true);
  });

  it("rejects a Check response with the wrong exact identity", async () => {
    const port = makePort({
      readCheckResult: async () => makeCheck({ result_id: "another-result" }),
    });
    const focus = makeFocus([
      makeReference("check", "check-result-7", "Project check at analysis revision"),
    ]);

    const snapshot = await createVerificationAdapter(port).load(focus);

    expect(snapshot.checks.status).toBe("ready");
    expect(snapshot.checks.items[0]).toMatchObject({
      status: "failed",
      failure: { code: "contract-mismatch" },
    });
    expect(snapshot.stale).toBe(false);
  });

  it("marks a Check from another revision stale and clears the snapshot truth", async () => {
    const port = makePort({
      readCheckResult: async () => makeCheck({ project_revision: 11 }),
    });
    const focus = makeFocus([
      makeReference("check", "check-result-7", "Project check"),
    ]);

    const snapshot = await createVerificationAdapter(port).load(focus);

    expect(snapshot.checks.status).toBe("stale");
    expect(snapshot.stale).toBe(true);
  });

  it("validates every plot preview identity, media type and payload independently", async () => {
    const plots = [
      makePlot({ plot_id: "plot-good" }),
      makePlot({ plot_id: "plot-wrong-id" }),
      makePlot({ plot_id: "plot-wrong-media" }),
      makePlot({ plot_id: "plot-unsafe", media_type: "image/svg+xml" }),
      makePlot({ plot_id: "plot-invalid-payload" }),
    ];
    const port = makePort({
      readPlots: async () => plots,
      readPlot: async (_scope, plotId) => {
        switch (plotId) {
          case "plot-good": return makePlotView({ plot_id: plotId });
          case "plot-wrong-id": return makePlotView({ plot_id: "other-plot" });
          case "plot-wrong-media": return makePlotView({ plot_id: plotId, media_type: "image/jpeg" });
          case "plot-unsafe": return makePlotView({ plot_id: plotId, media_type: "image/svg+xml" });
          default: return makePlotView({ plot_id: plotId, data_base64: "not base64!" });
        }
      },
    });
    const focus = makeFocus(plots.map((plot) => makeReference("plot", plot.plot_id, plot.plot_id)));

    const snapshot = await createVerificationAdapter(port).load(focus);

    expect(snapshot.plots.items.map(({ preview }) => preview)).toEqual([
      expect.objectContaining({ status: "ready" }),
      { status: "failed", reason: "id-mismatch" },
      { status: "failed", reason: "media-mismatch" },
      { status: "failed", reason: "unsupported-media" },
      { status: "failed", reason: "invalid-payload" },
    ]);
    expect(snapshot.stale).toBe(false);
  });

  it("keeps malformed references unresolved and does not call a reader", async () => {
    const readArtifacts = vi.fn(async () => [makeArtifact()]);
    const malformed = makeReference("artifact", "", "Broken reference");
    const snapshot = await createVerificationAdapter(makePort({ readArtifacts })).load(
      makeFocus([malformed]),
    );

    expect(readArtifacts).not.toHaveBeenCalled();
    expect(snapshot.invalidReferences).toEqual([malformed]);
    expect(snapshot.artifacts.status).toBe("unlinked");
  });

  it("preserves an exact Finding reference as unresolved until a typed Finding reader exists", async () => {
    const finding = makeReference("finding", "finding:seed", "Randomness finding");
    const snapshot = await createVerificationAdapter(makePort()).load(makeFocus([finding]));

    expect(snapshot.invalidReferences).toEqual([finding]);
    expect(snapshot.checks.status).toBe("unlinked");
  });

  it("fails a source rather than selecting between duplicate exact records", async () => {
    const port = makePort({
      readArtifacts: async () => [makeArtifact(), makeArtifact({ output_path: "outputs/duplicate.csv" })],
    });
    const snapshot = await createVerificationAdapter(port).load(makeFocus([
      makeReference("artifact", "artifact-differential-expression", "DE table"),
    ]));

    expect(snapshot.artifacts.status).toBe("failed");
    expect(snapshot.artifacts.failure).toEqual({ code: "contract-mismatch" });
    expect(snapshot.artifacts.items).toEqual([]);
  });
});
