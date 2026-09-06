// Local protocol acceptance only. PATH contains fake OpenSSH/Slurm executables;
// no remote host is contacted and no real scheduler job is submitted.
import assert from "node:assert/strict";
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
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: command === "cargo" ? 900_000 : 60_000, ...options });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.signal);
  return result.stdout;
}
run("cargo", ["build", "--manifest-path", "Cargo.toml", "-p", "rho-cli", "--locked", "--offline"]);
const metadata = JSON.parse(run("cargo", ["metadata", "--manifest-path", "Cargo.toml", "--no-deps", "--format-version", "1", "--offline"]));
const binary = path.join(metadata.target_directory, "debug/rho");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rho-remote-protocol-"));
const project = path.join(directory, "local");
const remote = path.join(directory, "remote ' space $(literal)");
const bin = path.join(directory, "bin");
for (const dir of [project, remote, bin]) fs.mkdirSync(dir);
const state = path.join(directory, "scheduler.json");
const log = path.join(directory, "ssh.jsonl");
const database = path.join(directory, "next.sqlite");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const helper = path.join(directory, "fake-tool.mjs");
fs.writeFileSync(state, JSON.stringify({ submissions: 0, jobs: [], cancel_requests: 0 }));
fs.writeFileSync(helper, `
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const [tool, ...args] = process.argv.slice(2);
const file = process.env.RHO_TEST_REMOTE_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const flag = (name) => args.find((arg) => arg.startsWith(name + "="))?.slice(name.length + 1);
if (tool === "ssh") {
  for (const required of ["-T", "BatchMode=yes", "StrictHostKeyChecking=yes", "ForwardAgent=no", "ControlPath=none"]) assert.ok(args.includes(required));
  assert.equal(args.at(-2), "fixture");
  fs.appendFileSync(process.env.RHO_TEST_REMOTE_LOG, JSON.stringify(args) + "\\n");
  const result = spawnSync("/bin/sh", ["-c", args.at(-1)], { input: fs.readFileSync(0), env: process.env });
  if (result.status === 0 && process.env.RHO_TEST_DROP_SUBMIT === "1" && args.at(-1).includes("sbatch")) process.exit(255);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 255);
}
if (tool === "scontrol") {
  console.log("ClusterName = " + (process.env.RHO_TEST_BAD_CLUSTER ? "other_cluster" : "fixture_cluster"));
} else if (tool === "sbatch") {
  assert.ok(args.includes("--parsable"));
  assert.ok(!Object.keys(process.env).some((name) => name.startsWith("SBATCH_")));
  const script = fs.readFileSync(0, "utf8");
  assert.match(script, /^#!\\/bin\\/bash\\nexport RHO_OPERATION_ID=/);
  const marker = flag("--job-name");
  assert.match(marker, /^rho-[a-f0-9]{64}$/);
  const id = String(4200 + ++state.submissions);
  state.jobs.push({ id, marker, root: fs.realpathSync(process.cwd()), state: "RUNNING", script });
  save();
  console.log(id + ";fixture_cluster");
} else if (tool === "squeue" || tool === "sacct") {
  assert.ok(flag("--user"));
  assert.ok(args.includes("--local"));
  if (tool === "sacct") assert.ok(args.includes("--starttime=now-30days"));
  for (const job of state.jobs.filter((job) => job.marker === flag("--name"))) {
    if (tool === "squeue" && job.state === "RUNNING") console.log([job.id, job.state, job.marker, job.root].join("|"));
    if (tool === "sacct" && job.state !== "RUNNING") console.log([job.id, job.state, "0:15", job.marker, job.root].join("|"));
  }
} else if (tool === "scancel") {
  assert.ok(!args.includes("--ctld"), "Slurm 19.05 does not support --ctld");
  assert.ok(flag("--user"));
  assert.ok(!Object.keys(process.env).some((name) => name.startsWith("SCANCEL_")));
  const jobs = state.jobs.filter((job) => job.marker === flag("--name"));
  assert.equal(jobs.length, 1);
  ++state.cancel_requests;
  save(); // request accepted, but deliberately do not change RUNNING yet
} else { throw new Error("unexpected fixture tool " + tool); }
`);
for (const name of ["ssh", "scontrol", "sbatch", "squeue", "sacct", "scancel"]) {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(helper)} ${quote(name)} "$@"\n`, { mode: 0o700 });
}
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RHO_TEST_REMOTE_STATE: state, RHO_TEST_REMOTE_LOG: log,
  SBATCH_ARRAY_INX: "1-100", SCANCEL_INTERACTIVE: "1" };
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
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
