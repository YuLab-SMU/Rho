// Local protocol acceptance only. PATH contains fake OpenSSH/Slurm executables;
// no remote host is contacted and no real scheduler job is submitted.
import assert from "node:assert/strict";
import { createRemoteFixture } from "./fixtures/ssh-slurm.mjs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

assert.notEqual(process.platform, "win32", "this POSIX transcript fixture is not Windows/remote acceptance");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function run(command, args, options = {}) {
  // The current Host catalog contains generated contracts for every registered
  // capability and exceeds Node's default 1 MiB pipe buffer. This is a fixture
  // capture bound, separate from native command output and execution deadlines.
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: command === "cargo" ? 900_000 : 60_000, ...options });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.signal);
  return result.stdout;
}
run("cargo", ["build", "--manifest-path", "Cargo.toml", "-p", "rho-cli", "--locked", "--offline"]);
const metadata = JSON.parse(run("cargo", ["metadata", "--manifest-path", "Cargo.toml", "--no-deps", "--format-version", "1", "--offline"]));
const binary = path.join(metadata.target_directory, "debug/rho");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rho-remote-protocol-"));
const { project, remote, state, log, env } = createRemoteFixture(directory);
const database = path.join(directory, "next.sqlite");
const common = ["--database", database, "--project", project, "--remote-host", "fixture", "--remote-root", fs.realpathSync(remote), "--slurm-cluster", "fixture_cluster"];
const invoke = (id, capability, arguments_, extra = {}) => JSON.parse(run(binary, [...common, "invoke", "--client-request-id", id,
  "--capability", capability, "--arguments", JSON.stringify(arguments_)], { env: { ...env, ...extra } })).operation;
const get = (id) => JSON.parse(run(binary, ["--database", database, "get-operation", id], { env })).operation;
const query = async (id) => {
  const frame = { id: "query", request: { method: "query_snapshot", params: { capability: { id: "slurm.snapshot", version: 1 }, arguments: { submission_operation_id: id } } } };
  const child = spawn(binary, [...common, "session"], { env, stdio: ["pipe", "pipe", "inherit"] });
  const ended = once(child, "exit");
  const lines = readline.createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const watchdog = setTimeout(() => child.kill(), 30_000);
  try {
    assert.equal(JSON.parse((await iterator.next()).value).type, "ready");
    // Compare within the same Host. Starting a writer may initialize database
    // metadata, which is not an effect of this subsequent Query.
    const before = fs.readFileSync(database);
    child.stdin.write(JSON.stringify(frame) + "\n");
    const reply = JSON.parse((await iterator.next()).value);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(fs.readFileSync(database), before, "Query changed its Host journal");
    return reply.result;
  } finally {
    child.stdin.end();
    await ended;
    lines.close();
    clearTimeout(watchdog);
  }
};
let complete = false;
try {
  const ready = JSON.parse(run(binary, [...common, "session"], { env, input: "" }));
  assert.ok(ready.capabilities.some((capability) => capability.capability.id === "slurm.submit"));
  assert.equal(ready.capabilities.find((capability) => capability.capability.id === "slurm.submit").input_schema.properties.cpus.maximum, 512);
  assert.equal(fs.existsSync(log), false, "Host startup connected to SSH");
  const literal = "spaces ' quotes ; $(touch escaped)";
  const remoteResult = invoke("literal", "process.run_remote", { program: "printf", args: ["%s", literal] });
  assert.equal(remoteResult.status, "succeeded");
  assert.equal(Buffer.from(remoteResult.output.transport.stdout.bytes).toString(), literal);
  assert.equal(fs.existsSync(path.join(remote, "escaped")), false);
  const failed = invoke("remote-failure", "process.run_remote", { program: "/bin/sh", args: ["-c", "exit 9"] });
  assert.equal(failed.status, "failed");
  const unconfirmed = invoke("remote-255", "process.run_remote", { program: "/bin/sh", args: ["-c", "exit 255"] });
  assert.equal(unconfirmed.status, "uncertain");
  const args = { body: "#SBATCH --array=1-100\nprintf scientific-body\\n", cpus: 2, memory_mb: 2048, time_minutes: 2 };
  const lost = invoke("lost-submit", "slurm.submit", args, { RHO_TEST_DROP_SUBMIT: "1" });
  assert.equal(lost.status, "uncertain", JSON.stringify(lost));
  const id = lost.operation.operation_id;
  assert.equal(JSON.parse(fs.readFileSync(state)).submissions, 1, JSON.stringify(lost));
  assert.deepEqual(invoke("lost-submit", "slurm.submit", args), lost);
  assert.equal(JSON.parse(fs.readFileSync(state)).submissions, 1);
  const snapshot = await query(id);
  assert.equal(snapshot.status, "ready", JSON.stringify(snapshot));
  assert.equal(snapshot.data.jobs[0].state, "RUNNING");
  const found = invoke("recover-submit", "slurm.reconcile", { submission_operation_id: id });
  assert.equal(found.status, "succeeded");
  assert.equal(found.output.jobs[0].job.job_id, "4201");
  assert.deepEqual(get(id), lost);
  const cancel = invoke("cancel-job", "slurm.request_cancel", { submission_operation_id: id });
  assert.equal(cancel.status, "succeeded");
  assert.equal(cancel.output.request_sent, true);
  assert.equal(cancel.output.after.state, "RUNNING", "cancel acknowledgement invented a terminal job state");
  let native = JSON.parse(fs.readFileSync(state));
  native.jobs[0].state = "CANCELLED"; fs.writeFileSync(state, JSON.stringify(native));
  const terminal = await query(id);
  assert.equal(terminal.data.jobs[0].state, "CANCELLED");
  assert.equal(terminal.data.jobs[0].source, "sacct");
  assert.equal(invoke("cancel-terminal", "slurm.request_cancel", { submission_operation_id: id }).output.request_sent, false);
  assert.equal(JSON.parse(fs.readFileSync(state)).cancel_requests, 1);
  const submitted = invoke("successful-submit", "slurm.submit", args);
  assert.equal(submitted.status, "succeeded", JSON.stringify(submitted));
  assert.equal(submitted.output.job_id, "4202");
  assert.equal(submitted.output.cluster, "fixture_cluster");
  assert.match(submitted.output.stdout_path, /-4202\.out$/u);
  assert.deepEqual(invoke("successful-submit", "slurm.submit", args), submitted);
  native = JSON.parse(fs.readFileSync(state));
  assert.equal(native.submissions, 2);
  native.jobs.push({ ...native.jobs[1], id: "4203" });
  fs.writeFileSync(state, JSON.stringify(native));
  const secondId = submitted.operation.operation_id;
  assert.equal(invoke("ambiguous-recovery", "slurm.reconcile", { submission_operation_id: secondId }).status, "uncertain");
  assert.equal(invoke("ambiguous-cancel", "slurm.request_cancel", { submission_operation_id: secondId }).status, "uncertain");
  assert.equal(JSON.parse(fs.readFileSync(state)).cancel_requests, 1);
  native.jobs = []; fs.writeFileSync(state, JSON.stringify(native));
  assert.equal(invoke("missing-job", "slurm.reconcile", { submission_operation_id: id }).status, "uncertain");
  assert.equal(invoke("cluster-mismatch", "slurm.submit", args, { RHO_TEST_BAD_CLUSTER: "1" }).status, "uncertain");
  assert.equal(JSON.parse(fs.readFileSync(state)).submissions, 2);
  console.log("Verified LOCAL-ONLY SSH/Slurm transcript: strict SSH options, quoting, no startup connection, native refs, lost receipt without replay, query purity and cancellation observation. No remote acceptance performed.");
  complete = true;
} finally {
  if (complete) fs.rmSync(directory, { recursive: true, force: true });
  else console.error(`Local SSH/Slurm evidence retained at ${directory}`);
}
