import { describe, expect, it } from "vitest";

import { createTauriHistoryTransport } from "./history";

describe("History and artifact generated read transport", () => {
  it("owns exact list and Plot preview commands", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const transport = createTauriHistoryTransport(
      async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push(args === undefined ? { command } : { command, args });
        if (command === "retry_run") {
          return { execution_id: "run:retry" } as T;
        }
        if (command === "read_plot_artifact") {
          return {
            plot_id: "plot:fixture",
            media_type: "image/png",
            data_base64: "iVBORw0KGgo=",
          } as T;
        }
        return [] as T;
      },
    );

    await transport.listRuns(30);
    await transport.listArtifactRecords(40, false);
    await transport.listProblems(50);
    await transport.listPlotArtifacts(60, true);
    await expect(transport.readPlotArtifact("plot:fixture")).resolves.toMatchObject({
      plot_id: "plot:fixture",
      media_type: "image/png",
    });
    await expect(transport.retryRun("run:failed")).resolves.toEqual({
      execution_id: "run:retry",
    });
    expect(calls).toEqual([
      { command: "list_runs", args: { limit: 30 } },
      { command: "list_artifact_records", args: { limit: 40, sessionOnly: false } },
      { command: "list_problems", args: { limit: 50 } },
      { command: "list_plot_artifacts", args: { limit: 60, sessionOnly: true } },
      { command: "read_plot_artifact", args: { plotId: "plot:fixture" } },
      { command: "retry_run", args: { runId: "run:failed" } },
    ]);
  });
});
