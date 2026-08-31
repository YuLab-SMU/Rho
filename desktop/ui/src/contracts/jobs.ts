export type JobState =
  | "prepared"
  | "queued"
  | "submitted"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "uncertain"
  | "reconciling";

export type JobResources = {
  cpu_millis: number;
  memory_bytes: number;
  max_processes: number;
  walltime_ms: number;
  disk_bytes: number;
  output_bytes: number;
};

export type JobSnapshot = {
  job_id: string;
  execution_id: string;
  operation_id: string;
  state: JobState;
  executor: "local_process" | "oci";
  requested_resources: JobResources;
  effective_resources: JobResources;
  queued_at_ms: number;
  submitted_at_ms: number | null;
  started_at_ms: number | null;
  terminal_at_ms: number | null;
  cancel_state: "not_requested" | "requested" | "process_tree_confirmed" | "reconcile_required";
  artifact_state: "pending" | "partial" | "committed" | "failed";
  logs: { sequence: number; stream: "stdout" | "stderr" | "system"; text: string }[];
  logs_truncated: boolean;
  artifacts: { artifact_id: string; digest: string; media_type: string; byte_size: number }[];
  terminal_reason_code: string | null;
  safe_next_action: string | null;
};

export type JobsSnapshot = {
  contract: "rho.ui.jobs.v1";
  contract_major: 1;
  snapshot_revision: number;
  jobs: JobSnapshot[];
};

const RESOURCES: JobResources = {
  cpu_millis: 1000,
  memory_bytes: 134217728,
  max_processes: 8,
  walltime_ms: 5000,
  disk_bytes: 67108864,
  output_bytes: 8388608,
};

export const JOBS_FIXTURE: JobsSnapshot = {
  contract: "rho.ui.jobs.v1",
  contract_major: 1,
  snapshot_revision: 12,
  jobs: [
    {
      job_id: "job_local_running",
      execution_id: "execution_local_running",
      operation_id: "operation_local_running",
      state: "running",
      executor: "local_process",
      requested_resources: { ...RESOURCES },
      effective_resources: { ...RESOURCES },
      queued_at_ms: 100,
      submitted_at_ms: 110,
      started_at_ms: 120,
      terminal_at_ms: null,
      cancel_state: "not_requested",
      artifact_state: "pending",
      logs: [{ sequence: 1, stream: "stdout", text: "Analysis started" }],
      logs_truncated: false,
      artifacts: [],
      terminal_reason_code: null,
      safe_next_action: null,
    },
    {
      job_id: "job_oci_uncertain",
      execution_id: "execution_oci_uncertain",
      operation_id: "operation_oci_uncertain",
      state: "uncertain",
      executor: "oci",
      requested_resources: { ...RESOURCES },
      effective_resources: { ...RESOURCES },
      queued_at_ms: 200,
      submitted_at_ms: 210,
      started_at_ms: 220,
      terminal_at_ms: 300,
      cancel_state: "reconcile_required",
      artifact_state: "partial",
      logs: [],
      logs_truncated: true,
      artifacts: [],
      terminal_reason_code: "oci_daemon_disconnect",
      safe_next_action: "Reconcile container identity; do not replay",
    },
  ],
};

export function validateJobsSnapshot(snapshot: JobsSnapshot): string[] {
  const errors: string[] = [];
  if (snapshot.contract !== "rho.ui.jobs.v1" || snapshot.contract_major !== 1) errors.push("contract");
  if (new Set(snapshot.jobs.map((job) => job.job_id)).size !== snapshot.jobs.length) {
    errors.push("duplicate_job");
  }
  for (const job of snapshot.jobs) {
    if (["succeeded", "failed", "cancelled", "uncertain"].includes(job.state) && job.terminal_reason_code === null) {
      errors.push(`${job.job_id}:terminal_without_reason`);
    }
    if (job.artifact_state !== "committed" && job.artifacts.length > 0) {
      errors.push(`${job.job_id}:artifact_before_cas_commit`);
    }
    if (job.state === "cancelled" && job.cancel_state === "requested") {
      errors.push(`${job.job_id}:cancel_not_confirmed`);
    }
    if (job.logs.length > 256) errors.push(`${job.job_id}:log_count`);
  }
  const encoded = JSON.stringify(snapshot).toLowerCase();
  for (const forbidden of ["provider_plan_id", "private_thinking", "plaintext_secret", "raw_host_path"]) {
    if (encoded.includes(forbidden)) errors.push(`forbidden:${forbidden}`);
  }
  return errors;
}

export function browserMockJobsFixture(): JobsSnapshot {
  return structuredClone(JOBS_FIXTURE) as JobsSnapshot;
}
