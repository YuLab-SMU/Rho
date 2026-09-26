// Shared LOCAL-ONLY SSH/Slurm native transcript fixture. Never contacts a cluster.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
export function createRemoteFixture(directory) {
const project = path.join(directory, "local");
const remote = path.join(directory, "remote ' space $(literal)");
const bin = path.join(directory, "bin");
for (const dir of [project, remote, bin]) fs.mkdirSync(dir);
const state = path.join(directory, "scheduler.json");
const log = path.join(directory, "ssh.jsonl");
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
return { project, remote, bin, state, log, env };
}
