import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { JobsPanel } from "../app/jobs/JobsPanel";
import { JOBS_FIXTURE, type JobsSnapshot } from "../contracts/jobs";

function fixture(): JobsSnapshot {
  return structuredClone(JOBS_FIXTURE) as JobsSnapshot;
}

function render(snapshot = fixture()): string {
  return renderToStaticMarkup(<JobsPanel snapshot={snapshot} />);
}

describe("JOBS_TEST truthful background Job Plane", () => {
  it("renders Rho-owned identity, executor, timestamps, and requested/effective resources", () => {
    const markup = render();
    for (const text of [
      "Job Plane",
      "job_local_running",
      "execution_local_running",
      "operation_local_running",
      "local process",
      "Requested",
      "Effective",
      "Memory bytes",
      "Walltime ms",
      "120 ms",
    ]) {
      expect(markup).toContain(text);
    }
  });

  it("keeps Job timeline independent from Agent Plan and Provider", () => {
    const encoded = JSON.stringify(JOBS_FIXTURE).toLowerCase();
    for (const forbidden of ["plan_id", "provider_id", "provider_session", "private_thinking"]) {
      expect(encoded).not.toContain(forbidden);
    }
    expect(render()).toContain("job_oci_uncertain");
  });

  it("distinguishes cancel requested from process-tree confirmed and reconcile", () => {
    const snapshot = fixture();
    snapshot.jobs.push(
      {
        ...snapshot.jobs[0]!,
        job_id: "job_cancel_requested",
        execution_id: "execution_cancel_requested",
        operation_id: "operation_cancel_requested",
        cancel_state: "requested",
      },
      {
        ...snapshot.jobs[0]!,
        job_id: "job_cancel_confirmed",
        execution_id: "execution_cancel_confirmed",
        operation_id: "operation_cancel_confirmed",
        state: "cancelled",
        terminal_reason_code: "cancelled_process_tree_confirmed",
        terminal_at_ms: 400,
        cancel_state: "process_tree_confirmed",
      },
    );
    const markup = render(snapshot);
    expect(markup).toContain("Cancellation requested; process-tree death is not yet confirmed.");
    expect(markup).toContain("Process tree confirmed dead.");
    expect(markup).toContain("Process identity requires reconciliation");
  });

  it("renders bounded logs and truncation truth instead of unbounded stream", () => {
    const markup = render();
    expect(markup).toContain("Analysis started");
    expect(markup).toContain("Logs truncated at the configured bound.");
  });

  it("opens artifacts only after CAS committed and explains partial collection", () => {
    const snapshot = fixture();
    snapshot.jobs.push({
      ...snapshot.jobs[0]!,
      job_id: "job_artifact_committed",
      execution_id: "execution_artifact_committed",
      operation_id: "operation_artifact_committed",
      state: "succeeded",
      terminal_reason_code: "required_artifacts_committed",
      terminal_at_ms: 500,
      artifact_state: "committed",
      artifacts: [
        {
          artifact_id: "artifact_result",
          digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          media_type: "text/csv",
          byte_size: 128,
        },
      ],
    });
    const markup = render(snapshot);
    expect(markup).toContain("Open committed artifact artifact_result");
    expect(markup).toContain("Partial collection requires reconciliation");
  });

  it("all terminal and uncertain states have explicit reason and safe next action", () => {
    const snapshot = fixture();
    for (const [index, state] of (["succeeded", "failed", "cancelled", "uncertain"] as const).entries()) {
      snapshot.jobs.push({
        ...snapshot.jobs[0]!,
        job_id: `job_terminal_${state}`,
        execution_id: `execution_terminal_${state}`,
        operation_id: `operation_terminal_${state}`,
        state,
        terminal_at_ms: 600 + index,
        terminal_reason_code: `${state}_reason`,
        safe_next_action: `safe action for ${state}`,
        cancel_state: state === "cancelled" ? "process_tree_confirmed" : "not_requested",
      });
    }
    const markup = render(snapshot);
    for (const state of ["succeeded", "failed", "cancelled", "uncertain"]) {
      expect(markup).toContain(`${state} reason`);
      expect(markup).toContain(`safe action for ${state}`);
    }
  });
});
