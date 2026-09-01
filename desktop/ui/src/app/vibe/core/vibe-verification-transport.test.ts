import { describe, expect, it, vi } from "vitest";

import { createMockUiKernelTransport } from "../../../transport/mock";
import {
  createTauriUiKernelTransport,
  type Invoke,
  type Listen,
} from "../../../transport/tauri";
import type { VibeVerificationReadFacets } from "./vibe-verification-read-port";

describe("Vibe typed verification transport aggregation", () => {
  it("exposes project-isolated typed records from the browser mock", async () => {
    const transport = createMockUiKernelTransport("project=%2Fprojects%2Fatlas-a");
    const facets: VibeVerificationReadFacets = transport;

    await expect(facets.listRuns(100)).resolves.toEqual([
      expect.objectContaining({ run_id: "run:mock-1", project_root: "/projects/atlas-a" }),
    ]);
    await expect(facets.listArtifactRecords(100, false)).resolves.toEqual([
      expect.objectContaining({
        artifact_id: "artifact:plot-1",
        project_root: "/projects/atlas-a",
      }),
    ]);
    await expect(facets.listPlotArtifacts(100, false)).resolves.toEqual([
      expect.objectContaining({ plot_id: "plot:mock-1", project_root: "/projects/atlas-a" }),
    ]);
    await expect(facets.listClaims({ limit: 100 })).resolves.toEqual(
      expect.objectContaining({
        items: [expect.objectContaining({ node_id: "claim:mock-1", kind: "claim" })],
      }),
    );
    await expect(facets.readPlotArtifact("plot:missing")).rejects.toThrow(
      "Mock Plot artifact is unavailable",
    );
  });

  it("spreads the existing typed Tauri History and Evidence command facets", async () => {
    const invokeMock = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      void args;
      if (command === "read_plot_artifact") {
        return { plot_id: "plot:1", media_type: "image/png", data_base64: "AAAA" };
      }
      if (command === "evidence_list_claims") {
        return {
          contract: "rho.ui.evidence-graph.v1",
          project_id: "project:test",
          items: [],
          next_cursor: null,
          has_more: false,
        };
      }
      return [];
    });
    const invoke: Invoke = <T,>(command: string, args?: Record<string, unknown>) => (
      invokeMock(command, args) as Promise<T>
    );
    const listen: Listen = async () => () => undefined;
    const transport = createTauriUiKernelTransport(invoke, listen);
    const facets: VibeVerificationReadFacets = transport;

    await facets.listRuns(7);
    await facets.listArtifactRecords(8, false);
    await facets.listPlotArtifacts(9, false);
    await facets.listClaims({ limit: 10 });
    await facets.readPlotArtifact("plot:1");

    expect(invokeMock).toHaveBeenCalledWith("list_runs", { limit: 7 });
    expect(invokeMock).toHaveBeenCalledWith("list_artifact_records", {
      limit: 8,
      sessionOnly: false,
    });
    expect(invokeMock).toHaveBeenCalledWith("list_plot_artifacts", {
      limit: 9,
      sessionOnly: false,
    });
    expect(invokeMock).toHaveBeenCalledWith("evidence_list_claims", {
      request: { cursor: null, include_drafts: false, limit: 10 },
    });
    expect(invokeMock).toHaveBeenCalledWith("read_plot_artifact", { plotId: "plot:1" });
  });
});
