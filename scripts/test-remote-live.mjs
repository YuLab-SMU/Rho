// Opt-in REAL remote acceptance. Creates two small Slurm jobs; cancels only the
// second, created specifically for lost-receipt/cancel testing.
// Usage: node scripts/test-remote-live.mjs ALIAS EMPTY_REMOTE_DIR CLUSTER PARTITION
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const [host, remoteRoot, cluster, partition] = process.argv.slice(2);
assert.equal(process.argv.length, 6, "explicit host, empty remote directory, cluster and CPU partition required");
assert.notEqual(process.platform, "win32", "this managed-relay acceptance has not been verified on Windows");
for (const value of [host, cluster, partition]) assert.match(value, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u);
assert.ok(remoteRoot.startsWith("/") && remoteRoot !== "/" && !/[\r\n\0]/u.test(remoteRoot));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    timeout: command === "cargo" ? 900_000 : 70_000, ...options,
  });
  assert.equal(result.status, 0, `${command}: ${result.error?.message || result.stderr || result.signal}`);
  return result.stdout;
}
const serverctl = process.env.RHO_SERVERCTL || run("sh", ["-c", "command -v serverctl"]).trim();
assert.ok(path.isAbsolute(serverctl), "RHO_SERVERCTL must resolve to the installed serverctl");
const probe = run(serverctl, ["exec", host, "--reuse", "300", "--json", "--", "sh", "-c",
  `set -eu; cd ${quote(remoteRoot)}; test "$(pwd -P)" = ${quote(remoteRoot)}; test -w .; test -z "$(ls -A .)"; sbatch --version`]);
const native = JSON.parse(probe);
assert.equal(native.ok, true, "remote directory must exist, be canonical, writable and empty");
console.log(`Real target: ${host}; ${native.stdout.trim()}; root=${remoteRoot}`);
run("cargo", ["build", "--locked", "--offline"]);
const metadata = JSON.parse(run("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked", "--offline"]));
const binary = path.join(metadata.target_directory, "debug/rho");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rho-remote-live-"));
const project = path.join(directory, "project");
const bin = path.join(directory, "bin");
fs.mkdirSync(project); fs.mkdirSync(bin);
const database = path.join(directory, "state.sqlite");
fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, "scripts/fixtures/remote-live-relay.mjs"))} "$@"\n`, { mode: 0o700 });
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RHO_ACCEPTANCE_HOST: host,
  RHO_ACCEPTANCE_SERVERCTL: serverctl, RHO_ACCEPTANCE_BASE_PATH: process.env.PATH };
const common = ["--database", database, "--project", project, "--remote-host", host,
  "--remote-root", remoteRoot, "--slurm-cluster", cluster];
const evidence = { host, remoteRoot, cluster, partition, database, operations: {}, native_jobs: [], complete: false };
const save = () => fs.writeFileSync(path.join(directory, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
function invoke(id, capability, arguments_, extra = {}) {
  const result = JSON.parse(run(binary, [...common, "invoke", "--client-request-id", id,
    "--capability", capability, "--arguments", JSON.stringify(arguments_)], { env: { ...env, ...extra } })).operation;
  evidence.operations[id] = result; save();
  return result;
}
const get = (id) => JSON.parse(run(binary, ["--database", database, "get-operation", id])).operation;
const succeeded = (record) => assert.equal(record.status, "succeeded", JSON.stringify(record));
const bytes = (capture) => Buffer.from(capture.bytes).toString("utf8");
async function query(id) {
  const child = spawn(binary, [...common, "session"], { env, stdio: ["pipe", "pipe", "inherit"] });
  const ended = once(child, "exit");
  const lines = readline.createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const watchdog = setTimeout(() => child.kill(), 65_000);
  try {
    assert.equal(JSON.parse((await iterator.next()).value).type, "ready");
    const before = fs.readFileSync(database);
    child.stdin.write(JSON.stringify({ id: "snapshot", request: { method: "query_snapshot", params: {
      capability: { id: "slurm.snapshot", version: 1 }, arguments: { submission_operation_id: id },
    } } }) + "\n");
    const reply = JSON.parse((await iterator.next()).value);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.result.status, "ready", JSON.stringify(reply));
    assert.deepEqual(fs.readFileSync(database), before, "live scheduler Query mutated its journal");
    return reply.result;
  } finally {
    child.stdin.end(); await ended; lines.close(); clearTimeout(watchdog);
  }
}
function waitForJob(job, expected) {
  const id = job.job_id;
  assert.match(id, /^[0-9]+$/u);
  assert.match(job.operation_marker, /^rho-[a-f0-9]{64}$/u);
  // One bounded waiter on the login host; no agent-side sleep/squeue loop.
  const script = String.raw`set -eu
rho_job=$1
rho_expected=$2
rho_marker=$3
rho_deadline=$(($(date +%s) + 150))
rho_previous=''
while :; do
  rho_queue=$(squeue --noheader --local --states=all --name="$rho_marker" --format='%i|%T' --user="$(id -un)")
  rho_accounting=$(sacct --noheader --parsable2 --allocations --local --jobs="$rho_job" --format='JobIDRaw,State%64,ExitCode' --user="$(id -un)")
  rho_state=$(printf '%s\n' "$rho_accounting" | awk -F '|' -v job="$rho_job" '$1 == job {print $2}')
  if [ -z "$rho_state" ]; then
    rho_state=$(printf '%s\n' "$rho_queue" | awk -F '|' -v job="$rho_job" '$1 == job {print $2}')
  fi
  if [ "$rho_state" != "$rho_previous" ]; then printf 'job=%s state=%s\n' "$rho_job" "$rho_state"; rho_previous=$rho_state; fi
  case "$rho_state" in
    COMPLETED*|CANCELLED*|FAILED*|TIMEOUT*|NODE_FAIL*|OUT_OF_MEMORY*|PREEMPTED*|BOOT_FAIL*|DEADLINE*|REVOKED*)
      case "$rho_state" in "$rho_expected"*) exit 0;; *) exit 1;; esac;;
  esac
  if [ "$(date +%s)" -ge "$rho_deadline" ]; then echo 'wait deadline; job outcome remains unresolved' >&2; exit 124; fi
  sleep 3
done
`;
  run(serverctl, ["exec", host, "--reuse", "300", "--timeout", "160", "--stdin", "--", "sh", "-s", "--", id, expected, job.operation_marker],
    { input: script, stdio: ["pipe", "inherit", "inherit"], timeout: 175_000 });
}

save();
console.log(`Recovery/evidence directory: ${directory}`);
try {
  const onceArgs = { program: "sh", args: ["-c", "printf x >> once.txt; printf remote-ok; printf native-stderr >&2"] };
  const first = invoke("remote-once", "process.run_remote", onceArgs); succeeded(first);
  assert.equal(bytes(first.output.transport.stdout), "remote-ok");
  assert.ok(bytes(first.output.transport.stderr).includes("native-stderr"));
  assert.deepEqual(invoke("remote-once", "process.run_remote", onceArgs), first);
  const readOnce = invoke("read-once", "process.run_remote", { program: "cat", args: ["once.txt"] }); succeeded(readOnce);
  assert.equal(bytes(readOnce.output.transport.stdout), "x");
  const literal = "spaces ' quotes ; $(literal) 中文\n";
  const stdin = invoke("stdin", "process.run_remote", { program: "cat", stdin: literal }); succeeded(stdin);
  assert.equal(bytes(stdin.output.transport.stdout), literal);
  const failure = invoke("native-failure", "process.run_remote", { program: "sh", args: ["-c", "exit 9"] });
  assert.equal(failure.status, "failed"); assert.equal(failure.output.remote_exit_code, 9);

  const normalArgs = { body: "printf 'result=42\\noperation=%s\\n' \"$RHO_OPERATION_ID\"\nprintf native-job-stderr >&2", cpus: 1, memory_mb: 64, time_minutes: 1, gpus: 0, partition };
  const normal = invoke("normal-submit", "slurm.submit", normalArgs); succeeded(normal);
  evidence.native_jobs.push(normal.output); save();
  console.log(`Submitted normal job ${normal.output.job_id}; 1 CPU, 64 MiB, 1 minute maximum.`);
  assert.deepEqual(invoke("normal-submit", "slurm.submit", normalArgs), normal);
  await query(normal.operation.operation_id);
  waitForJob(normal.output, "COMPLETED");
  const completed = await query(normal.operation.operation_id);
  assert.equal(completed.data.jobs.length, 1);
  assert.equal(completed.data.jobs[0].job.job_id, normal.output.job_id);
  assert.ok(completed.data.jobs[0].state.startsWith("COMPLETED"));
  const output = invoke("job-output", "process.run_remote", { program: "cat", args: [normal.output.stdout_path] }); succeeded(output);
  assert.ok(bytes(output.output.transport.stdout).includes("result=42\n"));
  assert.ok(bytes(output.output.transport.stdout).includes(normal.operation.operation_id));

  const lossFile = path.join(directory, "discarded-native-receipt.txt");
  const lostArgs = { body: "printf 'started=%s\\n' \"$RHO_OPERATION_ID\"\nsleep 90\nprintf unexpected-completion", cpus: 1, memory_mb: 64, time_minutes: 2, gpus: 0, partition };
  const lost = invoke("lost-submit", "slurm.submit", lostArgs, { RHO_ACCEPTANCE_DROP_RECEIPT: lossFile });
  assert.equal(lost.status, "uncertain", JSON.stringify(lost));
  assert.ok(fs.existsSync(lossFile), "the receipt must be lost AFTER a real successful submission");
  const realId = fs.readFileSync(lossFile, "utf8").trim().split(";")[0];
  console.log(`Submitted fault-injection job ${realId}; receipt intentionally discarded; 1 CPU, 64 MiB, 2 minute maximum.`);
  assert.deepEqual(invoke("lost-submit", "slurm.submit", lostArgs), lost);
  const recovered = invoke("reconcile-lost", "slurm.reconcile", { submission_operation_id: lost.operation.operation_id }); succeeded(recovered);
  assert.equal(recovered.output.jobs.length, 1, "native lookup must find exactly one job, not a replay");
  const recoveredJob = recovered.output.jobs[0].job;
  assert.equal(recoveredJob.job_id, realId, "reconcile must discover the native job without being given its ID");
  evidence.native_jobs.push(recoveredJob); save();
  assert.deepEqual(get(lost.operation.operation_id), lost);
  const cancel = invoke("cancel-test-job", "slurm.request_cancel", { submission_operation_id: lost.operation.operation_id }); succeeded(cancel);
  assert.equal(cancel.output.request_sent, true);
  console.log(`Cancellation requested for test job ${realId}; waiting for scheduler confirmation.`);
  waitForJob(recoveredJob, "CANCELLED");
  const cancelled = await query(lost.operation.operation_id);
  assert.equal(cancelled.data.jobs.length, 1);
  assert.ok(cancelled.data.jobs[0].state.startsWith("CANCELLED"));
  assert.deepEqual(get(lost.operation.operation_id), lost, "reconciliation must not rewrite the uncertain source");
  const again = invoke("cancel-terminal", "slurm.request_cancel", { submission_operation_id: lost.operation.operation_id }); succeeded(again);
  assert.equal(again.output.request_sent, false);
  evidence.complete = true; save();
  console.log(`Verified REAL remote execution, native Slurm completion/output, lost receipt without resubmission, reconciliation, cancellation and Query purity. Evidence retained at ${directory}; remote files retained at ${remoteRoot}.`);
} catch (error) {
  save();
  console.error(`Acceptance stopped. Do not rerun or resubmit blindly. Inspect ${directory}/evidence.json and the original Operations; remote test files remain at ${remoteRoot}.`);
  throw error;
}
