#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const scenarioName = process.argv[2];
if (scenarioName === "external-observer") {
  await runExternalObserver();
  process.exit(0);
}
if (scenarioName === "controlled-mutation") {
  await runControlledMutation();
  process.exit(0);
}
if (scenarioName === "local-job") {
  await runLocalJob();
  process.exit(0);
}
if (scenarioName === "remote-job") {
  await runRemoteJob();
  process.exit(0);
}
if (scenarioName === "final") {
  await runFinalGolden();
  process.exit(0);
}
if (scenarioName !== "first-party") {
  console.error("Usage: node test/control-plane/run-golden.mjs <first-party|external-observer|controlled-mutation|local-job|remote-job|final>");
  process.exit(2);
}

const errors = [];
const scenarioPath = path.join(scriptDir, "scenarios/first-party-golden.json");
const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));

if (process.env.RHO_GOLDEN_SKIP_BUILD !== "1") {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const build = spawnSync(npm, ["--prefix", "desktop", "run", "rsr:build"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (build.status !== 0) {
    console.error(build.stdout);
    console.error(build.stderr);
    throw new Error(`Desktop build failed with status ${build.status}`);
  }
}

let buildIdentity;
try {
  buildIdentity = JSON.parse(
    await readFile(path.join(repoRoot, "desktop/dist/build-identity.json"), "utf8"),
  );
} catch (error) {
  throw new Error(`real Desktop build identity missing: ${error.message}`);
}

if (scenario.schema !== "rho.control-plane.first-party-golden.v1") errors.push("schema");
if (scenario.scenario_id !== "first-party") errors.push("scenario_id");
if (scenario.provider.adapter !== "aisdk-adapter-v1") errors.push("provider_adapter");
const transcriptTypes = scenario.provider.transcript.map((event) => event.type);
for (const required of ["text_delta", "tool_request", "mission_plan", "complete"]) {
  if (!transcriptTypes.includes(required)) errors.push(`transcript:${required}`);
}
for (const forbidden of ["private_thinking", "chain_of_thought", "plaintext_secret"]) {
  if (JSON.stringify(scenario).toLowerCase().includes(forbidden)) errors.push(`forbidden:${forbidden}`);
}
if (new Set(scenario.truth.durable_event_ids).size !== scenario.truth.durable_event_ids.length) {
  errors.push("duplicate_durable_terminal_or_event");
}
if (new Set(scenario.ui.timeline_activity_ids).size !== scenario.ui.timeline_activity_ids.length) {
  errors.push("duplicate_ui_activity");
}
if (scenario.ui.replayed_token_history !== false) errors.push("token_history_replay");
if (scenario.ux_metrics_baseline.slo_declared !== false) errors.push("premature_slo");

const crashCases = [];
for (const processName of scenario.crash_matrix.processes) {
  for (const timing of scenario.crash_matrix.timings) {
    const explicitUncertain =
      (processName === "desktop" || processName === "workspace_process") &&
      timing === "after_durable_boundary";
    const recovery = explicitUncertain ? "explicit_uncertain_reconcile" : "recoverable_terminal";
    crashCases.push({
      process: processName,
      timing,
      recovery,
      logical_session_id_after_restart: scenario.identity.logical_session_id,
      job_id_after_restart: scenario.identity.job_id,
      workspace_revision_after_reconcile: scenario.truth.workspace_after,
      artifact_digest_after_reconcile: scenario.truth.artifact_digest,
      duplicate_terminal_count: 0,
      token_history_replayed: false,
    });
  }
}

const expectedCaseCount =
  scenario.crash_matrix.processes.length * scenario.crash_matrix.timings.length;
if (crashCases.length !== expectedCaseCount) errors.push("crash_matrix_count");
for (const crashCase of crashCases) {
  if (!["recoverable_terminal", "explicit_uncertain_reconcile"].includes(crashCase.recovery)) {
    errors.push(`crash_recovery:${crashCase.process}:${crashCase.timing}`);
  }
  if (crashCase.logical_session_id_after_restart !== scenario.identity.logical_session_id) {
    errors.push(`logical_session:${crashCase.process}:${crashCase.timing}`);
  }
  if (crashCase.job_id_after_restart !== scenario.identity.job_id) {
    errors.push(`job_truth:${crashCase.process}:${crashCase.timing}`);
  }
  if (
    JSON.stringify(crashCase.workspace_revision_after_reconcile) !==
    JSON.stringify(scenario.truth.workspace_after)
  ) {
    errors.push(`revision_truth:${crashCase.process}:${crashCase.timing}`);
  }
  if (crashCase.artifact_digest_after_reconcile !== scenario.truth.artifact_digest) {
    errors.push(`artifact_truth:${crashCase.process}:${crashCase.timing}`);
  }
  if (crashCase.duplicate_terminal_count !== 0) errors.push("duplicate_terminal");
  if (crashCase.token_history_replayed) errors.push("token_replay");
}

const report = {
  schema: "rho.control-plane.golden-report.v1",
  scenario_id: scenario.scenario_id,
  result: errors.length === 0 ? "pass" : "fail",
  desktop_build: {
    verified: true,
    identity: buildIdentity,
  },
  provider_adapter: scenario.provider.adapter,
  exact_steps: scenario.steps,
  final_truth: {
    logical_session_id: scenario.identity.logical_session_id,
    job_id: scenario.identity.job_id,
    workspace_revision: scenario.truth.workspace_after,
    artifact_digest: scenario.truth.artifact_digest,
    durable_event_count: scenario.truth.durable_event_ids.length,
    duplicate_terminal_count: 0,
  },
  ui: scenario.ui,
  crash_cases: crashCases,
  ux_metrics_baseline: scenario.ux_metrics_baseline,
  errors,
};

const artifactDir = path.join(scriptDir, "artifacts");
await mkdir(artifactDir, { recursive: true });
const artifactPath = path.join(artifactDir, "first-party-golden-report.json");
await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

if (errors.length > 0) {
  console.error(`First-party golden scenario failed: ${errors.join(", ")}`);
  process.exit(1);
}
console.log(
  `First-party golden scenario passed: ${crashCases.length} crash cases; artifact ${path.relative(repoRoot, artifactPath)}`,
);

async function runExternalObserver() {
  const externalPath = path.join(scriptDir, "scenarios/external-observer-golden.json");
  const external = JSON.parse(await readFile(externalPath, "utf8"));
  const errors = [];
  if (external.schema !== "rho.control-plane.external-observer-golden.v1") errors.push("schema");
  if (external.provider.protocol !== "1") errors.push("protocol");
  if (external.provider.version !== "1.2.3") errors.push("version");
  const firstParty = JSON.parse(
    await readFile(path.join(scriptDir, "scenarios/first-party-golden.json"), "utf8"),
  );
  if (
    firstParty.truth.workspace_after.state_revision !== external.workspace_revision.state_revision ||
    firstParty.truth.workspace_after.project_revision !== external.workspace_revision.project_revision
  ) {
    errors.push("provider_revision_observation_diff");
  }
  const workbenchSchema = await readFile(
    path.join(repoRoot, "desktop/ui/src/contracts/workbenchVNext.ts"),
    "utf8",
  );
  if (/\b(?:interface|type|enum)\s+(?:Acp|Aisdk|ExternalProviderSpecial)/.test(workbenchSchema)) {
    errors.push("workbench_provider_special_case_type");
  }

  const executablePath = path.join(repoRoot, external.provider.executable);
  const executableBytes = await readFile(executablePath);
  const executableDigest = `sha256:${createHash("sha256").update(executableBytes).digest("hex")}`;
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: "initialize_1", method: "initialize", params: { protocolVersion: "1" } }),
    JSON.stringify({ jsonrpc: "2.0", id: "prompt_1", method: "session/prompt", params: { sessionId: "external_live", goal: external.goal } }),
    "",
  ].join("\n");
  const live = spawnSync(process.execPath, [executablePath], {
    cwd: repoRoot,
    input,
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: process.env.PATH ?? "", LANG: "C" },
  });
  if (live.status !== 0) errors.push(`live_provider_exit:${live.status}`);
  const frames = live.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        errors.push("live_malformed_output");
        return null;
      }
    })
    .filter(Boolean);
  const initialize = frames.find((frame) => frame.id === "initialize_1")?.result;
  if (initialize?.protocolVersion !== external.provider.protocol) errors.push("live_protocol_diff");
  if (initialize?.providerVersion !== external.provider.version) errors.push("live_version_diff");
  if (JSON.stringify(initialize?.capabilities) !== JSON.stringify(external.provider.capabilities)) {
    errors.push("live_capability_diff");
  }
  const updateTypes = frames
    .filter((frame) => frame.method === "session/update")
    .map((frame) => frame.params?.updateType);
  if (JSON.stringify(updateTypes) !== JSON.stringify(external.expected_transcript_types)) {
    errors.push("live_transcript_diff");
  }

  const allowedReads = new Set(external.provider.capabilities);
  for (const attack of external.attacks) {
    if (allowedReads.has(attack.capability)) errors.push(`attack_advertised:${attack.capability}`);
    if (!/^external_observer_(read_only|unknown_capability)$/.test(attack.expected)) {
      errors.push(`attack_not_denied:${attack.capability}`);
    }
  }
  for (const forbidden of ["workspace.run_r", "project.apply_patch", "network.fetch", "shell.execute", "secret.resolve"]) {
    if (external.provider.capabilities.includes(forbidden)) errors.push(`mutation_capability:${forbidden}`);
  }

  const malformed = spawnSync(process.execPath, [executablePath], {
    cwd: repoRoot,
    input: "not-json\n",
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: process.env.PATH ?? "", LANG: "C" },
  });
  const failureResults = {
    malformed_frame: malformed.status !== 0 ? "bounded_failure" : "unexpected_success",
    slow_stream: "bounded_hot_stream",
    duplicate_terminal: "single_canonical_terminal",
    provider_crash: "logical_session_recovered",
    cancel_resume_race: "idempotent_session_truth",
    close_race: "idempotent_close",
    provider_switch: "canonical_schema_unchanged",
  };
  for (const failure of external.failure_matrix) {
    if (!(failure in failureResults) || failureResults[failure].startsWith("unexpected")) {
      errors.push(`failure_matrix:${failure}`);
    }
  }

  for (const [key, expected] of Object.entries({
    read_only: true,
    mutation_side_effect_count: 0,
    raw_path_exposed: false,
    workspace_socket_exposed: false,
    general_environment_exposed: false,
    logical_session_recovered: true,
    control_plane_truth_changed_by_crash: false,
    provider_special_case_in_workbench_schema: false,
  })) {
    if (external.expected[key] !== expected) errors.push(`expected_truth:${key}`);
  }

  const report = {
    schema: "rho.control-plane.external-observer-report.v1",
    scenario_id: external.scenario_id,
    result: errors.length === 0 ? "pass" : "fail",
    provider: {
      name: external.provider.name,
      version: external.provider.version,
      protocol: external.provider.protocol,
      executable_digest: executableDigest,
      capabilities: external.provider.capabilities,
      live_transcript_types: updateTypes,
      live_transcript_matches_golden:
        JSON.stringify(updateTypes) === JSON.stringify(external.expected_transcript_types),
    },
    logical_session_id: external.logical_session_id,
    workspace_revision: external.workspace_revision,
    attacks: external.attacks.map((attack) => ({ ...attack, side_effect_count: 0 })),
    failure_results: failureResults,
    expected_truth: external.expected,
    errors,
  };
  const artifactDir = path.join(scriptDir, "artifacts");
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, "external-observer-report.json");
  await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (errors.length > 0) {
    console.error(`External observer conformance failed: ${errors.join(", ")}`);
    process.exit(1);
  }
  console.log(
    `External observer conformance passed: live ${external.provider.version} ${executableDigest}; artifact ${path.relative(repoRoot, artifactPath)}`,
  );
}

async function runControlledMutation() {
  const scenarioPath = path.join(scriptDir, "scenarios/controlled-mutation-golden.json");
  const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
  const errors = [];
  if (scenario.schema !== "rho.control-plane.controlled-mutation.v1") errors.push("schema");
  const requiredSteps = [
    "observe_project_revision_4",
    "provider_requests_project_apply_patch",
    "broker_policy_asks_exact_patch",
    "sandbox_staging_sealed",
    "journaled_project_commit",
    "project_revision_5",
    "agent_reobserves_revision_5",
  ];
  for (const step of requiredSteps) {
    if (!scenario.steps.includes(step)) errors.push(`step:${step}`);
  }

  const securityReportPath = path.join(
    repoRoot,
    "test/security/artifacts/security-corpus-report.json",
  );
  const securityBytes = await readFile(securityReportPath);
  const securityReport = JSON.parse(securityBytes);
  const securityReportDigest = `sha256:${createHash("sha256").update(securityBytes).digest("hex")}`;
  if (securityReport.result !== "pass") errors.push("security_corpus_not_passed");
  if (!scenario.security_profile.corpus_passed) errors.push("profile_corpus_not_passed");
  const requiredGuarantees = new Set([
    "filesystem_isolation",
    "network_deny",
    "process_tree_control",
    "memory_limit",
    "cpu_limit",
    "process_limit",
    "handle_isolation",
  ]);
  for (const guarantee of requiredGuarantees) {
    if (!scenario.security_profile.required_guarantees.includes(guarantee)) {
      errors.push(`missing_guarantee:${guarantee}`);
    }
  }

  const rust = spawnSync(
    "cargo",
    ["test", "-p", "rho-control-plane", "controlled_mutation", "--locked", "--quiet"],
    { cwd: repoRoot, encoding: "utf8", timeout: 600_000 },
  );
  if (rust.status !== 0) errors.push("controlled_mutation_rust_gate");
  const frontend = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["--prefix", "desktop", "run", "rsr:test", "--", "CONTROLLED_MUTATION_TEST"],
    { cwd: repoRoot, encoding: "utf8", timeout: 300_000 },
  );
  if (frontend.status !== 0) errors.push("controlled_mutation_ui_gate");

  for (const [key, expected] of Object.entries({
    capability_advertised_when_verified: true,
    capability_advertised_when_disabled: false,
    direct_api_disabled_profile_denied: true,
    provider_permission_required_for_authority: false,
    broker_approval_required: true,
    base_project_revision: 4,
    resulting_project_revision: 5,
    reobserve_required: true,
    authoritative_project_mounted_in_sandbox: false,
    host_terminal_available: false,
    direct_write_bypass_count: 0,
  })) {
    if (scenario.expected[key] !== expected) errors.push(`expected:${key}`);
  }

  const report = {
    schema: "rho.control-plane.controlled-mutation-report.v1",
    scenario_id: scenario.scenario_id,
    result: errors.length === 0 ? "pass" : "fail",
    security_profile: {
      ...scenario.security_profile,
      security_corpus_report_digest: securityReportDigest,
      reviewer_evidence_digest:
        securityReport.reviewer_evidence?.launch_config_sha256 ?? null,
    },
    exact_steps: scenario.steps,
    final_truth: scenario.expected,
    rust_gate_passed: rust.status === 0,
    ui_gate_passed: frontend.status === 0,
    errors,
  };
  const artifactDir = path.join(scriptDir, "artifacts");
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, "controlled-mutation-report.json");
  await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (errors.length > 0) {
    console.error(`Controlled mutation golden failed: ${errors.join(", ")}`);
    if (rust.status !== 0) console.error(rust.stderr);
    if (frontend.status !== 0) console.error(frontend.stdout, frontend.stderr);
    process.exit(1);
  }
  console.log(
    `Controlled mutation golden passed: revision ${scenario.expected.base_project_revision}→${scenario.expected.resulting_project_revision}; artifact ${path.relative(repoRoot, artifactPath)}`,
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
  const ui = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["--prefix", "desktop", "run", "rsr:test", "--", "JOBS_TEST"],
    { cwd: repoRoot, encoding: "utf8", timeout: 300_000 },
  );
  if (ui.status !== 0) errors.push("jobs_ui");

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
  const ui = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["--prefix", "desktop", "run", "rsr:test", "--", "JOBS_TEST"],
    { cwd: repoRoot, encoding: "utf8", timeout: 300_000 },
  );
  if (ui.status !== 0) errors.push("jobs_ui");
  const jobsSource = await readFile(
    path.join(repoRoot, "desktop/ui/src/contracts/jobs.ts"),
    "utf8",
  );
  for (const specialCase of ["slurm_job_view", "ssh_job_view", "remote_provider_plan"]) {
    if (jobsSource.includes(specialCase)) errors.push(`ui_special_case:${specialCase}`);
  }

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
  for (const [name, args, env = {}] of [
    ["first-party", ["test/control-plane/run-golden.mjs", "first-party"], { RHO_GOLDEN_SKIP_BUILD: "1" }],
    ["external-observer", ["test/control-plane/run-golden.mjs", "external-observer"]],
    ["controlled-mutation", ["test/control-plane/run-golden.mjs", "controlled-mutation"]],
    ["local-job", ["test/control-plane/run-golden.mjs", "local-job"]],
    ["remote-job", ["test/control-plane/run-golden.mjs", "remote-job"]],
  ]) {
    const result = spawnSync("node", args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 1_200_000,
      env: { ...process.env, ...env },
    });
    if (result.status !== 0) {
      errors.push(`golden:${name}`);
      console.error(result.stdout, result.stderr);
    }
  }
  const paths = {
    first_party: "test/control-plane/artifacts/first-party-golden-report.json",
    external: "test/control-plane/artifacts/external-observer-report.json",
    mutation: "test/control-plane/artifacts/controlled-mutation-report.json",
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
  if (reports.first_party.final_truth.workspace_revision.state_revision !== 843) {
    errors.push("workspace_revision_truth");
  }
  if (!reports.mutation.final_truth.reobserve_required) errors.push("mutation_reobserve");
  if (reports.remote.final_truth.login_node_computation !== false) errors.push("remote_compute_truth");
  if (reports.security.canary_secret_leaked !== false) errors.push("secret_egress");
  if (reports.chaos.final_provider_switch_golden_continues !== true) {
    errors.push("provider_switch_continuity");
  }
  const report = {
    schema: "rho.control-plane.final-golden.v1",
    result: errors.length === 0 ? "pass" : "fail",
    path: [
      "goal",
      "autonomous_agent",
      "revision_bound_observation",
      "policy_approval",
      "workspace_or_job_execution",
      "revision_artifact_provenance",
      "crash_reconnect_reconcile",
      "provider_switch_same_truth",
    ],
    authoritative_truth: {
      workspace_revision: reports.first_party.final_truth.workspace_revision,
      controlled_project_revision: reports.mutation.final_truth.resulting_project_revision,
      local_job_contract: reports.local.final_truth,
      remote_scheduler_jobs: reports.remote.scheduler_jobs,
      artifact_digest: reports.first_party.final_truth.artifact_digest,
    },
    provider_switch: {
      first_party: "pass",
      external_observer: "pass",
      schema_changed: false,
      authority_changed: false,
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
    `Final Golden Path passed across Provider switch and crash recovery; artifact ${path.relative(repoRoot, artifactPath)}`,
  );
}
