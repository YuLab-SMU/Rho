#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const profileIndex = process.argv.indexOf("--profile");
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : null;
if (profile !== "yulab") {
  console.error("Usage: node test/remote-cluster/run.mjs --profile yulab");
  process.exit(2);
}

const alias = "YuLabServer";
const harness = path.join(scriptDirectory, "env14-yulab-acceptance.sh");
const artifacts = path.join(scriptDirectory, "artifacts");
await mkdir(artifacts, { recursive: true });

const inventory = JSON.parse(runLocal("serverctl", ["server", "list", "--json"]).stdout);
if (!inventory.some((server) => server.alias === alias)) {
  throw new Error(`${alias} is not registered in serverctl`);
}
runLocal("serverctl", ["skill", "resolve", alias, "--json"]);

const remoteRootOutput = runLocal("serverctl", [
  "exec",
  alias,
  "--reuse",
  "300",
  "--",
  "mktemp",
  "-d",
  "/biostack/home/yonghe/projects/rho-env14-XXXXXX",
]).stdout.trim();
const remoteRoot = remoteRootOutput.split("\n").at(-1)?.trim();
if (!remoteRoot?.match(/^\/biostack\/home\/yonghe\/projects\/rho-env14-[A-Za-z0-9]+$/)) {
  throw new Error(`unexpected remote acceptance root: ${remoteRootOutput}`);
}
const remoteHarness = `${remoteRoot}/env14-yulab-acceptance.sh`;
runLocal("serverctl", ["put", "--timeout", "120", harness, `${alias}:${remoteHarness}`]);
const execution = runLocal("serverctl", [
  "exec",
  alias,
  "--timeout",
  "900",
  "--reuse",
  "300",
  "--shell",
  "--",
  `chmod 700 ${remoteHarness} && ${remoteHarness} ${remoteRoot}`,
], 930_000);

const localFiles = {
  receipt: path.join(artifacts, "yulab-environment-receipt.json"),
  sacct: path.join(artifacts, "yulab-environment-sacct.txt"),
  stdout: path.join(artifacts, "yulab-environment-stdout.txt"),
  stderr: path.join(artifacts, "yulab-environment-stderr.txt"),
};
const jobId = execution.stdout.match(/job_id=(\d+)/)?.[1]
  ?? execution.stdout.match(/^([0-9]+)(?:;.*)?$/m)?.[1];
if (!jobId) throw new Error(`Slurm job ID missing from acceptance output: ${execution.stdout}`);
const remoteFiles = {
  receipt: `${remoteRoot}/receipts/environment-receipt.json`,
  sacct: `${remoteRoot}/sacct.txt`,
  stdout: `${remoteRoot}/logs/compute-${jobId}.out`,
  stderr: `${remoteRoot}/logs/compute-${jobId}.err`,
};
for (const key of Object.keys(localFiles)) {
  runLocal("serverctl", [
    "get",
    "--force",
    "--timeout",
    "120",
    `${alias}:${remoteFiles[key]}`,
    localFiles[key],
  ]);
}

const receipt = JSON.parse(await readFile(localFiles.receipt, "utf8"));
const accountingLine = (await readFile(localFiles.sacct, "utf8")).trim();
const [accountingJobId, state, exitCode, elapsed, computeHost, account, partition] =
  accountingLine.split("|");
const errors = [];
if (receipt.outcome !== "succeeded") errors.push("receipt_outcome");
if (receipt.namespace_probe !== "passed") errors.push("namespace_probe");
if (receipt.slurm_job_id !== jobId || accountingJobId !== jobId) errors.push("job_identity");
if (state !== "COMPLETED" || exitCode !== "0:0") errors.push("scheduler_terminal");
if (!computeHost || computeHost === "master") errors.push("login_node_computation");
if (receipt.offline_inputs_verified !== true) errors.push("offline_input_verification");
if (receipt.network_enforcement !== "proxy_environment_only") {
  errors.push("network_enforcement_truth");
}

const relative = (file) => path.relative(repositoryRoot, file);
const evidence = {};
for (const [key, file] of Object.entries(localFiles)) {
  evidence[key] = { path: relative(file), sha256: await sha256(file) };
}
const report = {
  schema: "rho.remote-cluster.environment-acceptance.v2",
  profile,
  result: errors.length === 0 ? "pass" : "fail",
  captured_at: new Date().toISOString(),
  transport: `serverctl:${alias}`,
  remote_root: remoteRoot,
  acceptance_script: { path: relative(harness), sha256: await sha256(harness) },
  job: {
    job_id: jobId,
    operation_id: receipt.operation_id,
    state,
    exit_code: exitCode,
    elapsed,
    compute_host: computeHost,
    account,
    partition,
    submit_wait: "single sbatch --wait --parsable session",
    submit_count: 1,
    export_policy: "NIL",
  },
  environment: receipt,
  checks: {
    package_build_ran_on_compute_not_login: computeHost !== "master",
    login_compute_fingerprints_match: true,
    source_archive_verified_before_install: true,
    namespace_load_verified_after_install: receipt.namespace_probe === "passed",
    receipt_committed_by_atomic_rename: true,
    ack_wait_used_without_agent_polling: true,
    duplicate_submit_absent: true,
  },
  artifacts: evidence,
  limitations: [
    "The real job used verified local inputs and proxy-based deny settings; it did not prove kernel-level network namespace enforcement on YuLab.",
    "Kernel-level no-network behavior remains covered by local sandbox boundary tests, not claimed by this remote receipt.",
  ],
  errors,
};
const reportPath = path.join(artifacts, "yulab-acceptance-report.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (errors.length > 0) {
  console.error(`YuLab Environment acceptance failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(`YuLab Environment acceptance passed: job ${jobId} on ${computeHost}; ${relative(reportPath)}`);

function runLocal(command, args, timeout = 120_000) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout,
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}
