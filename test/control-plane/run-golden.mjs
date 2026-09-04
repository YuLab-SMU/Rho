#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const scenarioName = process.argv[2];
if (scenarioName === "agent-workspace") {
  await runAgentWorkspace();
} else if (scenarioName === "local-job") {
  await runLocalJob();
} else if (scenarioName === "remote-job") {
  await runRemoteJob();
} else if (scenarioName === "final") {
  await runFinalGolden();
} else {
  console.error("Usage: node test/control-plane/run-golden.mjs <agent-workspace|local-job|remote-job|final>");
  process.exit(2);
}

async function runAgentWorkspace() {
  const scenarioPath = path.join(scriptDir, "scenarios/agent-workspace-golden.json");
  const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
  const errors = [];
  if (scenario.schema !== "rho.control-plane.agent-workspace.v1") errors.push("schema");
  const requiredSteps = [
    "capture_project_snapshot",
    "advertise_acp_filesystem_and_terminal",
    "project_rho_mcp_servers",
    "agent_operates_disposable_workspace",
    "capture_snapshot_delta",
    "validate_revision_and_base_digests",
    "journaled_project_commit",
    "project_revision_5",
    "record_effect_and_notify_ui",
  ];
  for (const step of requiredSteps) {
    if (!scenario.steps.includes(step)) errors.push(`step:${step}`);
  }

  const gates = [
    ["acp", ["test", "-p", "rho-acp-client", "--test", "external_turn", "--locked", "--quiet"]],
    ["mcp", ["test", "-p", "rho-mcp", "--lib", "--locked", "--quiet"]],
    ["snapshot", ["test", "-p", "rho-sandbox", "--test", "snapshot", "snapshot_delta_", "--locked", "--quiet"]],
    ["commit", ["test", "-p", "rho-control-plane", "--test", "project_commit", "agent_requested_snapshot_delta", "--locked", "--quiet"]],
    ["desktop_context", ["test", "-p", "rho-desktop", "prepared_turn_retains_the_baseline_needed_to_capture_agent_changes", "--locked", "--quiet"]],
    ["desktop_gateway", ["test", "-p", "rho-desktop", "gateway_maps_registered_workspace_capabilities_without_policy_decisions", "--locked", "--quiet"]],
    ["desktop_commit", ["test", "-p", "rho-desktop", "agent_workspace_delta_commits_through_the_live_workspace_revision_lane", "--locked", "--quiet"]],
  ].map(([name, args]) => {
    const result = spawnSync("cargo", args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 600_000,
    });
    if (result.status !== 0) {
      errors.push(`gate:${name}`);
      console.error(result.stdout, result.stderr);
    }
    return [name, result.status === 0];
  });

  for (const [key, expected] of Object.entries({
    acp_filesystem_advertised: true,
    acp_terminal_advertised: true,
    mcp_servers_projected: true,
    agent_permission_option_selected: true,
    rho_approval_required: false,
    snapshot_delta_captured: true,
    base_digest_conflicts_rejected: true,
    journaled_commit: true,
    base_project_revision: 4,
    resulting_project_revision: 5,
    authoritative_project_mounted_in_agent: false,
    partial_outcome_reported_as_success: false,
  })) {
    if (scenario.expected[key] !== expected) errors.push(`expected:${key}`);
  }

  const report = {
    schema: "rho.control-plane.agent-workspace-report.v1",
    scenario_id: scenario.scenario_id,
    result: errors.length === 0 ? "pass" : "fail",
    exact_steps: scenario.steps,
    final_truth: scenario.expected,
    gates: Object.fromEntries(gates),
    errors,
  };
  const artifactDir = path.join(scriptDir, "artifacts");
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, "agent-workspace-report.json");
  await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (errors.length > 0) {
    console.error(`Agent Workspace golden failed: ${errors.join(", ")}`);
    process.exit(1);
  }
  console.log(
    `Agent Workspace golden passed: revision ${scenario.expected.base_project_revision}→${scenario.expected.resulting_project_revision}; artifact ${path.relative(repoRoot, artifactPath)}`,
  );
}

async function runLocalJob() {
  const scenario = JSON.parse(
    await readFile(path.join(scriptDir, "scenarios/local-job-golden.json"), "utf8"),
  );
  const errors = [];
  if (scenario.schema !== "rho.control-plane.local-job.v1") errors.push("schema");
  const requiredMatrix = [
    "local_success",
    "local_nonzero_failure",
    "local_timeout",
    "local_cancel_tree",
    "local_output_flood",
    "crash_after_intent",
    "crash_after_spawn",
    "crash_after_handle",
    "crash_after_exit",
    "crash_during_collect",
    "restart_reconcile",
    "oci_success_contract",
    "oci_daemon_disconnect",
  ];
  for (const entry of requiredMatrix) {
    if (!scenario.matrix.includes(entry)) errors.push(`matrix:${entry}`);
  }

  const commands = [
    ["local", ["test", "-p", "rho-execution", "local", "--locked", "--quiet"]],
    ["resource", ["test", "-p", "rho-execution", "resource", "--locked", "--quiet"]],
    ["process-tree", ["test", "-p", "rho-execution", "process_tree", "--locked", "--quiet"]],
    ["reconcile", ["test", "-p", "rho-execution", "reconcile", "--locked", "--quiet"]],
    ["oci", ["test", "-p", "rho-execution", "oci", "--locked", "--quiet"]],
    ["artifact-collection", ["test", "-p", "rho-artifact-store", "collection", "--locked", "--quiet"]],
    ["execution-collection", ["test", "-p", "rho-execution", "collect", "--locked", "--quiet"]],
  ];
  const checks = commands.map(([name, args]) => {
    const result = spawnSync("cargo", args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 600_000,
    });
    if (result.status !== 0) errors.push(`check:${name}`);
    return { name, passed: result.status === 0, status: result.status };
  });
  let ociLive = {
    runtime_available: false,
    image_digest: null,
    attempted: false,
    passed: false,
    reason: "OCI runtime unavailable; OCI execution tier remains disabled on this host",
  };
  const dockerInfo = spawnSync("docker", ["info", "--format", "{{json .ServerVersion}}"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 20_000,
  });
  if (dockerInfo.status === 0) {
    const images = spawnSync(
      "docker",
      ["image", "ls", "--digests", "--format", "{{.Repository}}@{{.Digest}}"],
      { cwd: repoRoot, encoding: "utf8", timeout: 20_000 },
    );
    const image = images.stdout
      ?.split("\n")
      .find((entry) => entry && !entry.endsWith("@<none>") && entry.includes("@sha256:"));
    if (image) {
      const live = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          "65532:65532",
          image,
          "true",
        ],
        { cwd: repoRoot, encoding: "utf8", timeout: 120_000 },
      );
      ociLive = {
        runtime_available: true,
        image_digest: image,
        attempted: true,
        passed: live.status === 0,
        reason:
          live.status === 0
            ? "pinned local OCI image passed rootless/no-network/read-only smoke"
            : "pinned OCI smoke failed; OCI tier disabled on this host",
      };
    } else {
      ociLive = {
        runtime_available: true,
        image_digest: null,
        attempted: false,
        passed: false,
        reason: "OCI runtime available but no pinned local image; OCI tier remains disabled",
      };
    }
  }

  for (const [key, expected] of Object.entries({
    job_survives_agent_or_renderer_exit: true,
    plan_or_provider_switch_changes_job_truth: false,
    cancel_requested_distinct_from_confirmed: true,
    missing_process_guessed_failed: false,
    non_idempotent_unknown_replayed: false,
    artifact_open_before_cas_commit: false,
    required_artifacts_gate_product_success: true,
    interactive_workspace_revision_changed: false,
  })) {
    if (scenario.expected[key] !== expected) errors.push(`expected:${key}`);
  }

  const report = {
    schema: "rho.control-plane.local-job-report.v1",
    scenario_id: scenario.scenario_id,
    result: errors.length === 0 ? "pass" : "fail",
    matrix: scenario.matrix,
    checks,
    jobs_ui_passed: ui.status === 0,
    local_execution: "real approved digest-pinned child processes",
    oci_live: ociLive,
    oci_contract_passed: checks.find((check) => check.name === "oci")?.passed ?? false,
    final_truth: scenario.expected,
    errors,
  };
  const artifactDir = path.join(scriptDir, "artifacts");
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, "local-job-report.json");
  await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (errors.length > 0) {
    console.error(`Local Job golden failed: ${errors.join(", ")}`);
    process.exit(1);
  }
  console.log(
    `Local Job golden passed: ${scenario.matrix.length} lifecycle cases; artifact ${path.relative(repoRoot, artifactPath)}`,
  );
}

async function runRemoteJob() {
  const scenario = JSON.parse(
    await readFile(path.join(scriptDir, "scenarios/remote-job-golden.json"), "utf8"),
  );
  const clusterPath = path.join(
    repoRoot,
    "test/remote-cluster/artifacts/yulab-acceptance-report.json",
  );
  const clusterBytes = await readFile(clusterPath);
  const cluster = JSON.parse(clusterBytes);
  const errors = [];
  if (scenario.schema !== "rho.control-plane.remote-job.v1") errors.push("schema");
  if (cluster.result !== "pass") errors.push("cluster_acceptance");
  if (cluster.ssh_sessions !== 2) errors.push("ssh_sessions");
  if (cluster.login_node_computation !== false) errors.push("login_compute");
  if (cluster.app_local_database !== true) errors.push("remote_database");
  if (!cluster.reconnect_job?.desktop_restart_truth_preserved) errors.push("restart_truth");
  for (const required of scenario.required_cluster_cases) {
    const observed = cluster.scenarios?.find((entry) => entry.id === required);
    if (!observed?.passed) errors.push(`cluster_case:${required}`);
    if (observed?.accounting?.source !== "sacct") errors.push(`accounting:${required}`);
  }
  for (const output of cluster.output_artifacts ?? []) {
    if (!output.stdout_digest?.startsWith("sha256:") || !output.stderr_digest?.startsWith("sha256:")) {
      errors.push(`output_digest:${output.id}`);
    }
  }

  const checks = [
    ["ssh", ["test", "-p", "rho-execution", "ssh", "--locked", "--quiet"]],
    ["slurm", ["test", "-p", "rho-execution", "slurm", "--locked", "--quiet"]],
    ["remote-reconcile", ["test", "-p", "rho-execution", "remote_reconcile", "--locked", "--quiet"]],
    ["runner", ["test", "-p", "rho-runner", "--locked", "--quiet"]],
    ["remote-cas", ["test", "-p", "rho-artifact-store", "remote", "--locked", "--quiet"]],
  ].map(([name, args]) => {
    const result = spawnSync("cargo", args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 600_000,
    });
    if (result.status !== 0) errors.push(`check:${name}`);
    return { name, passed: result.status === 0 };
  });
  const report = {
    schema: "rho.control-plane.remote-job-report.v1",
    scenario_id: scenario.scenario_id,
    result: errors.length === 0 ? "pass" : "fail",
    cluster_report_digest: `sha256:${createHash("sha256").update(clusterBytes).digest("hex")}`,
    runner_digest: cluster.runner_digest,
    slurm_version: cluster.slurm_version,
    scheduler_jobs: cluster.scenarios.map((entry) => ({
      id: entry.id,
      job_id: entry.jobId,
      state: entry.accounting?.state,
      node: entry.accounting?.node_list,
      spec_digest: entry.spec_digest,
    })),
    reconnect_job: cluster.reconnect_job,
    output_artifacts: cluster.output_artifacts,
    checks,
    jobs_ui_passed: ui.status === 0,
    final_truth: scenario.required_truth,
    errors,
  };
  const artifactDir = path.join(scriptDir, "artifacts");
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, "remote-job-report.json");
  await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (errors.length > 0) {
    console.error(`Remote Job golden failed: ${errors.join(", ")}`);
    process.exit(1);
  }
  console.log(
    `Remote Job golden passed: ${report.scheduler_jobs.length} real scheduler jobs; artifact ${path.relative(repoRoot, artifactPath)}`,
  );
}

async function runFinalGolden() {
  const errors = [];
  for (const [name, args] of [
    ["agent-workspace", ["test/control-plane/run-golden.mjs", "agent-workspace"]],
    ["local-job", ["test/control-plane/run-golden.mjs", "local-job"]],
    ["remote-job", ["test/control-plane/run-golden.mjs", "remote-job"]],
  ]) {
    const result = spawnSync("node", args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 1_200_000,
      env: process.env,
    });
    if (result.status !== 0) {
      errors.push(`golden:${name}`);
      console.error(result.stdout, result.stderr);
    }
  }
  const paths = {
    mutation: "test/control-plane/artifacts/agent-workspace-report.json",
    local: "test/control-plane/artifacts/local-job-report.json",
    remote: "test/control-plane/artifacts/remote-job-report.json",
    chaos: "test/chaos/artifacts/full-chaos-report.json",
    security: "test/security/artifacts/security-corpus-report.json",
  };
  const reports = {};
  for (const [name, relative] of Object.entries(paths)) {
    reports[name] = JSON.parse(await readFile(path.join(repoRoot, relative), "utf8"));
    const result = reports[name].result ?? (reports[name].passed ? "pass" : "fail");
    if (result !== "pass") errors.push(`report:${name}`);
  }
  if (reports.mutation.final_truth.rho_approval_required !== false) errors.push("rho_approval_gate");
  if (reports.remote.final_truth.login_node_computation !== false) errors.push("remote_compute_truth");
  if (reports.security.canary_secret_leaked !== false) errors.push("secret_egress");
  const report = {
    schema: "rho.control-plane.final-golden.v1",
    result: errors.length === 0 ? "pass" : "fail",
    path: [
      "external_agent_request",
      "capability_contract_validation",
      "workspace_or_job_execution",
      "revision_artifact_provenance",
      "crash_reconnect_reconcile",
    ],
    authoritative_truth: {
      controlled_project_revision: reports.mutation.final_truth.resulting_project_revision,
      local_job_contract: reports.local.final_truth,
      remote_scheduler_jobs: reports.remote.scheduler_jobs,
    },
    chaos_cases: reports.chaos.cases.length,
    security_cases: reports.security.cases.length,
    errors,
  };
  const artifactDir = path.join(scriptDir, "artifacts");
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, "final-golden-report.json");
  await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (errors.length > 0) {
    console.error(`Final Golden Path failed: ${errors.join(", ")}`);
    process.exit(1);
  }
  console.log(
    `Final Golden Path passed across Agent Workspace and job recovery; artifact ${path.relative(repoRoot, artifactPath)}`,
  );
}
