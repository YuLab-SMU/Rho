#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../..");
const profileIndex = process.argv.indexOf("--profile");
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : null;
if (profile !== "yulab") {
  console.error("Usage: node test/remote-cluster/run.mjs --profile yulab");
  process.exit(2);
}

const errors = [];
const temporary = await mkdtemp(path.join(os.tmpdir(), "rho-yulab-p7-"));
const archive = path.join(temporary, "rho-source.tar.gz");
const remoteRoot = "/biostack/home/yonghe/.rho/acceptance/rho-rebuild-p7";
const remoteArchive = `${remoteRoot}/rho-source.tar.gz`;

runLocal("tar", [
  "-czf",
  archive,
  "--exclude=target",
  "--exclude=node_modules",
  "--exclude=dist",
  "--exclude=desktop/src-tauri/binaries",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "crates",
  "vendor/jet",
  "desktop/src-tauri",
  "test/remote-cluster/yulab-driver.mjs",
]);
runServer("YuLabServer", `rm -rf ${remoteRoot} && mkdir -p ${remoteRoot}`, 120);
runLocal("serverctl", [
  "put",
  "--timeout",
  "300",
  archive,
  `YuLabServer:${remoteArchive}`,
]);
runServer(
  "YuLabServer",
  `mkdir -p ${remoteRoot}/source && tar -xzf ${remoteArchive} -C ${remoteRoot}/source`,
  300,
);

const firstSession = runServer(
  "YuLabServer",
  `node ${remoteRoot}/source/test/remote-cluster/yulab-driver.mjs run ${remoteRoot}`,
  1800,
);
const secondSession = runServer(
  "YuLabServer",
  `node ${remoteRoot}/source/test/remote-cluster/yulab-driver.mjs reconnect ${remoteRoot}`,
  300,
);
if (!firstSession.stdout.trim()) errors.push("first_ssh_session_no_report");
if (!secondSession.stdout.trim()) errors.push("reconnect_ssh_session_no_report");

const artifactDirectory = path.join(scriptDir, "artifacts");
await mkdir(artifactDirectory, { recursive: true });
const remoteReportLocal = path.join(artifactDirectory, "yulab-remote-report.json");
runLocal("serverctl", [
  "get",
  "--force",
  "--timeout",
  "300",
  `YuLabServer:${remoteRoot}/cluster-report.json`,
  remoteReportLocal,
]);
const report = JSON.parse(await readFile(remoteReportLocal, "utf8"));
if (report.schema !== "rho.remote-cluster.yulab.v1") errors.push("report_schema");
if (report.phase !== "reconnected_and_complete") errors.push("reconnect_phase");
if (!report.runner?.digest?.startsWith("sha256:")) errors.push("runner_digest");
if (!report.runner?.config_digest?.startsWith("sha256:")) errors.push("config_digest");
if (report.login_node_computation !== false) errors.push("login_node_ran_compute");
if ((report.remote_database_files ?? []).length > 0) errors.push("remote_database_present");
if (!report.reconnect_job?.separate_ssh_session) errors.push("ssh_reconnect_not_separate");
if (!report.reconnect_job?.desktop_restart_truth_preserved) errors.push("desktop_restart_truth");
for (const id of ["normal", "failure", "timeout", "gpu_numa"]) {
  const scenario = report.scenarios?.find((entry) => entry.id === id);
  if (!scenario) {
    errors.push(`missing_scenario:${id}`);
    continue;
  }
  if (!scenario.passed) errors.push(`scenario_failed:${id}:${scenario.accounting?.state}`);
  if (!scenario.spec_digest?.startsWith("sha256:")) errors.push(`spec_digest:${id}`);
  if (scenario.accounting?.source !== "sacct") errors.push(`scheduler_truth:${id}`);
  if (scenario.accounting?.node_list === "master") errors.push(`login_compute:${id}`);
}
const gpu = report.scenarios?.find((entry) => entry.id === "gpu_numa");
if (gpu?.partition !== "gpu_batch" || gpu?.gpu_count !== 1) errors.push("gpu_profile");
for (const output of report.output_artifacts ?? []) {
  if (output.stdout_digest === null || output.stderr_digest === null) {
    errors.push(`output_digest:${output.id}`);
  }
}

const downloadedOutput = {};
const normal = report.output_artifacts?.find((entry) => entry.id === "normal");
if (normal?.stdout) {
  const downloaded = path.join(artifactDirectory, "yulab-normal.stdout");
  runLocal("serverctl", [
    "get",
    "--force",
    "--timeout",
    "120",
    `YuLabServer:${normal.stdout}`,
    downloaded,
  ]);
  const localDigest = `sha256:${createHash("sha256")
    .update(await readFile(downloaded))
    .digest("hex")}`;
  if (localDigest !== normal.stdout_digest) errors.push("end_to_end_output_digest");
  downloadedOutput.normal = (await readFile(downloaded, "utf8")).trim();
}
const gpuOutput = report.output_artifacts?.find((entry) => entry.id === "gpu_numa");
if (gpuOutput?.stdout) {
  const downloaded = path.join(artifactDirectory, "yulab-gpu-numa.stdout");
  runLocal("serverctl", [
    "get",
    "--force",
    "--timeout",
    "120",
    `YuLabServer:${gpuOutput.stdout}`,
    downloaded,
  ]);
  const bytes = await readFile(downloaded);
  const localDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (localDigest !== gpuOutput.stdout_digest) errors.push("gpu_output_digest");
  downloadedOutput.gpu_numa = bytes.toString("utf8").trim();
  if (!downloadedOutput.gpu_numa.includes("gnode01")) errors.push("gpu_compute_node");
  if (!downloadedOutput.gpu_numa.includes("CUDA_VISIBLE_DEVICES=")) errors.push("gpu_visibility_evidence");
  if (!downloadedOutput.gpu_numa.includes("nodebind:")) errors.push("numa_evidence");
}

const acceptance = {
  schema: "rho.remote-cluster.acceptance.v1",
  profile,
  result: errors.length === 0 ? "pass" : "fail",
  remote_root: remoteRoot,
  ssh_sessions: 2,
  runner_digest: report.runner?.digest,
  runner_version: report.runner?.version,
  slurm_version: report.slurm?.version,
  cluster: report.slurm?.cluster,
  scenarios: report.scenarios,
  reconnect_job: report.reconnect_job,
  output_artifacts: report.output_artifacts,
  downloaded_output_evidence: downloadedOutput,
  app_local_database: (report.remote_database_files ?? []).length === 0,
  login_node_computation: false,
  secret_scope: "serverctl local credential; no key in command, report, or remote general env",
  errors,
};
const acceptancePath = path.join(artifactDirectory, "yulab-acceptance-report.json");
await writeFile(acceptancePath, `${JSON.stringify(acceptance, null, 2)}\n`);
await rm(temporary, { recursive: true, force: true });

if (errors.length > 0) {
  console.error(`YuLab real-cluster acceptance failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(
  `YuLab real-cluster acceptance passed: ${report.scenarios.length} scheduler cases, 2 SSH sessions; artifact ${path.relative(root, acceptancePath)}`,
);

function runLocal(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 1_800_000,
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
}

function runServer(alias, command, timeout) {
  const result = spawnSync(
    "serverctl",
    ["exec", alias, "--timeout", String(timeout), "--shell", "--", command],
    { cwd: root, encoding: "utf8", timeout: (timeout + 30) * 1000 },
  );
  if (result.status !== 0) {
    throw new Error(`remote ${alias} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
}
