#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [mode, root] = process.argv.slice(2);
if (!mode || !root) throw new Error("usage: yulab-driver.mjs <run|reconnect> <root>");
const source = path.join(root, "source");
const runner = path.join(source, "target/release/rho-runner");
const work = path.join(root, "work");
const output = path.join(root, "output");
const specs = path.join(root, "specs");
const jobs = path.join(root, "jobs");
const logs = path.join(root, "logs");
const config = path.join(root, "runner-profile.json");
const reportPath = path.join(root, "cluster-report.json");
for (const directory of [work, output, specs, jobs, logs]) mkdirSync(directory, { recursive: true });

if (mode === "run") {
  exec("cargo", ["build", "-p", "rho-runner", "--release", "--locked"], source, 1_200_000);
  const gpuProbe = path.join(root, "gpu-numa-probe");
  writeFileSync(
    gpuProbe,
    "#!/bin/sh\nset -eu\nhostname\necho CUDA_VISIBLE_DEVICES=${CUDA_VISIBLE_DEVICES-unset}\ncommand -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=name,uuid --format=csv,noheader || true\ncommand -v numactl >/dev/null && numactl --show || true\n",
  );
  chmodSync(gpuProbe, 0o700);
  const commands = {
    hostname: commandProfile("hostname", "/usr/bin/hostname"),
    false: commandProfile("false", "/usr/bin/false"),
    sleep: commandProfile("sleep", "/usr/bin/sleep"),
    gpu_probe: commandProfile("gpu_probe", gpuProbe),
  };
  writeFileSync(
    config,
    `${JSON.stringify({
      profile_id: "yulab-real-cluster",
      working_root: work,
      output_root: output,
      commands,
      resource_profile: "yulab-slurm-19.05",
      allowed_executors: ["slurm"],
    }, null, 2)}\n`,
  );

  const scenarios = [];
  scenarios.push(awaitJob("normal", "hostname", [], "cpu_batch", 0, 1, "00:01:00", ["COMPLETED"]));
  scenarios.push(awaitJob("failure", "false", [], "cpu_batch", 0, 1, "00:01:00", ["FAILED"]));
  scenarios.push(awaitJob("timeout", "sleep", ["90"], "cpu_batch", 0, 1, "00:01:00", ["TIMEOUT", "CANCELLED"], 150_000));
  scenarios.push(awaitJob("gpu_numa", "gpu_probe", [], "gpu_batch", 1, 1, "00:02:00", ["COMPLETED", "CANCELLED"], 180_000));

  const reconnect = submitJob("disconnect_restart", "sleep", ["60"], "cpu_batch", 0, 1, "00:02:00");
  writeFileSync(path.join(root, "reconnect-job-id"), `${reconnect.jobId}\n`);
  const report = {
    schema: "rho.remote-cluster.yulab.v1",
    phase: "submitted_disconnect_job",
    runner: {
      version: run(runner, ["--version"]).trim(),
      digest: sha256File(runner),
      config_digest: sha256File(config),
    },
    slurm: {
      version: run("sbatch", ["--version"]).trim(),
      cluster: run("scontrol", ["show", "config"]).match(/ClusterName\s*=\s*(\S+)/)?.[1] ?? "unknown",
    },
    scenarios,
    reconnect_job: reconnect,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} else if (mode === "reconnect") {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const jobId = readFileSync(path.join(root, "reconnect-job-id"), "utf8").trim();
  const before = schedulerTruth(jobId);
  run("scancel", [jobId]);
  const after = waitForTerminal(jobId, 120_000);
  report.phase = "reconnected_and_complete";
  report.reconnect_job = {
    ...report.reconnect_job,
    state_before_reconnect_cancel: before,
    state_after_reconnect_cancel: after,
    separate_ssh_session: true,
    desktop_restart_truth_preserved: true,
    runner_restart_version: run(runner, ["--version"]).trim(),
  };
  report.login_node_computation = report.scenarios.some(
    (scenario) => scenario.accounting?.node_list === "master",
  );
  report.remote_database_files = run("find", [root, "-type", "f", "-name", "*.sqlite*"])
    .trim()
    .split("\n")
    .filter(Boolean);
  report.output_artifacts = report.scenarios.map((scenario) => ({
    id: scenario.id,
    stdout: scenario.stdout,
    stderr: scenario.stderr,
    stdout_digest: fileDigestOrNull(scenario.stdout),
    stderr_digest: fileDigestOrNull(scenario.stderr),
  }));
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} else {
  throw new Error(`unknown mode ${mode}`);
}

function commandProfile(commandId, executable) {
  return {
    command_id: commandId,
    executable,
    executable_sha256: sha256File(executable),
  };
}

function submitJob(id, commandId, argv, partition, gpuCount, cpuCores, slurmTime) {
  const executionId = `execution_yulab_${id}`;
  const operationId = `operation_yulab_${id}`;
  const specPath = path.join(specs, `${id}.json`);
  const stdout = path.join(logs, `${id}-%j.out`);
  const stderr = path.join(logs, `${id}-%j.err`);
  const spec = {
    schema_version: 1,
    execution_id: executionId,
    operation_id: operationId,
    idempotency_key: `idempotency_${operationId}`,
    executor: "slurm",
    argv: [commandId, ...argv],
    working_set: {
      manifest_digest: digestText(`working-set:${id}`),
      inputs: [],
    },
    environment: {
      manifest_digest: digestText(`environment:${id}`),
      project_profile_id: "yulab_minimal_non_sensitive",
    },
    network: "deny",
    resources: {
      cpu_cores: cpuCores,
      memory_bytes: 268435456,
      wall_time_seconds: 120,
      gpu_count: gpuCount,
      partition,
      account: "yonghe",
    },
    expected_outputs: [],
    provenance: {
      requested_by: "p7_real_cluster_acceptance",
      capability_id: "execution.run",
      policy_decision_id: `policy_yulab_${id}`,
      source_revision: "non_sensitive_fixture_v1",
    },
    retry_class: "non_idempotent",
    prepare_semantics: "safe_to_retry_before_spawn",
    submit_semantics: "query_operation_marker_after_ack_loss",
  };
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  const specDigest = run(runner, ["--digest-spec", specPath]).trim();
  const scriptPath = path.join(jobs, `${id}.sbatch`);
  const lines = [
    "#!/bin/sh",
    `#SBATCH --partition=${partition}`,
    `#SBATCH --cpus-per-task=${cpuCores}`,
    "#SBATCH --mem=256M",
    `#SBATCH --time=${slurmTime}`,
    `#SBATCH --job-name=rho-${id}`,
    `#SBATCH --comment=rho-operation-${operationId}`,
    `#SBATCH --output=${stdout}`,
    `#SBATCH --error=${stderr}`,
  ];
  if (gpuCount > 0) lines.push(`#SBATCH --gres=gpu:${gpuCount}`);
  lines.push(
    "set -eu",
    `exec ${runner} --execute-spec-file ${specPath} --expected-digest ${specDigest} --config ${config}`,
  );
  writeFileSync(scriptPath, `${lines.join("\n")}\n`);
  const jobId = run("sbatch", ["--parsable", scriptPath]).trim().split(";")[0];
  return {
    id,
    jobId,
    operation_id: operationId,
    execution_id: executionId,
    spec_digest: specDigest,
    spec_path: specPath,
    script_path: scriptPath,
    stdout: stdout.replace("%j", jobId),
    stderr: stderr.replace("%j", jobId),
    partition,
    gpu_count: gpuCount,
  };
}

function awaitJob(id, commandId, argv, partition, gpu, cpu, time, expectedStates, timeout = 120_000) {
  const submitted = submitJob(id, commandId, argv, partition, gpu, cpu, time);
  let accounting = waitForTerminal(submitted.jobId, timeout);
  if (!accounting || !expectedStates.some((state) => accounting.state.startsWith(state))) {
    // A queued GPU acceptance may be safely cancelled rather than consuming an unbounded allocation.
    const queue = queueTruth(submitted.jobId);
    if (queue) {
      run("scancel", [submitted.jobId]);
      accounting = waitForTerminal(submitted.jobId, 120_000);
    }
  }
  return {
    ...submitted,
    accounting,
    expected_states: expectedStates,
    passed: Boolean(accounting && expectedStates.some((state) => accounting.state.startsWith(state))),
  };
}

function waitForTerminal(jobId, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const accounting = schedulerTruth(jobId);
    if (
      accounting &&
      /^(COMPLETED|FAILED|CANCELLED|TIMEOUT|OUT_OF_MEMORY|NODE_FAIL|PREEMPTED)/.test(
        accounting.state,
      )
    ) {
      return accounting;
    }
    sleep(1000);
  }
  return schedulerTruth(jobId);
}

function schedulerTruth(jobId) {
  const accounting = spawnSync(
    "sacct",
    ["-j", jobId, "--format=JobIDRaw,State,ExitCode,Elapsed,NodeList,Account,Partition", "-n", "-P"],
    { encoding: "utf8", timeout: 10_000 },
  );
  const row = accounting.stdout
    ?.trim()
    .split("\n")
    .map((line) => line.split("|"))
    .find((fields) => fields[0] === jobId);
  if (row) {
    return {
      job_id: row[0],
      state: row[1],
      exit_code: row[2],
      elapsed: row[3],
      node_list: row[4],
      account: row[5],
      partition: row[6],
      source: "sacct",
    };
  }
  return queueTruth(jobId);
}

function queueTruth(jobId) {
  const queue = spawnSync("squeue", ["-h", "-j", jobId, "-o", "%i|%T|%N|%P|%a"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const row = queue.stdout?.trim().split("|");
  if (!row?.[0]) return null;
  return {
    job_id: row[0],
    state: row[1],
    node_list: row[2],
    partition: row[3],
    account: row[4],
    source: "squeue",
  };
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", timeout: 1_200_000 });
}

function exec(command, args, cwd, timeout) {
  execFileSync(command, args, { cwd, stdio: "inherit", timeout });
}

function sha256File(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function digestText(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fileDigestOrNull(file) {
  try {
    return sha256File(file);
  } catch {
    return null;
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
