import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function run(command, args, input) {
  const result = spawnSync(command, args, { cwd: root, input, encoding: "utf8", timeout: command === "cargo" ? 900_000 : 30_000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.signal);
  return result.stdout;
}
run("cargo", ["build", "--manifest-path", "Cargo.toml", "-p", "rho-cli", "--locked", "--offline"]);
const metadata = JSON.parse(run("cargo", ["metadata", "--manifest-path", "Cargo.toml", "--no-deps", "--format-version", "1", "--offline"]));
const binary = path.join(metadata.target_directory, "debug", process.platform === "win32" ? "rho.exe" : "rho");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rho-process-recovery-"));
const project = path.join(directory, "project");
fs.mkdirSync(project);
const database = path.join(directory, "next.sqlite");
const common = ["--database", database, "--project", project];
const invocation = (id, capability, args, prefix = common) => [...prefix, "invoke", "--client-request-id", id,
  "--capability", capability, "--arguments", JSON.stringify(args)];
const invoke = (...args) => JSON.parse(run(binary, invocation(...args))).operation;
const get = (id) => JSON.parse(run(binary, ["--database", database, "get-operation", id])).operation;

async function deadline(promise, duration, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), duration); })]); }
  finally { clearTimeout(timer); }
}
const server = net.createServer();
const peers = new Map();
let expectedCount = 0, resolvePeers;
let host, hostEnded, control, controlEnded;
function waitPeers(count) {
  expectedCount = count;
  return peers.size >= count ? Promise.resolve() : new Promise((resolve) => { resolvePeers = resolve; });
}
server.on("connection", (socket) => {
  let data = "";
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    data += chunk.toString("utf8");
    if (!data.includes("\n")) return;
    const info = JSON.parse(data.split("\n")[0]);
    peers.set(info.role, { ...info, socket, closed });
    if (peers.size >= expectedCount) resolvePeers?.();
  });
});

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const fixture = path.join(project, "worker.mjs");
  fs.writeFileSync(fixture, `
import net from "node:net";
import { spawn } from "node:child_process";
import fs from "node:fs";
const role = process.argv[2];
const port = Number(process.argv[3]);
if (role === "parent") {
  fs.appendFileSync(process.argv[4], "executed once\\n");
  const child = spawn(process.execPath, [process.argv[1], "detached", String(port)], { detached: true, stdio: "ignore" });
  child.unref();
}
const socket = net.connect(port, "127.0.0.1", () => {
  socket.write(JSON.stringify({ role, pid: process.pid, operation_id: process.env.RHO_OPERATION_ID }) + "\\n");
});
socket.on("data", () => process.exit(0)); // test-owned failure cleanup, not production recovery
socket.on("error", () => process.exit(0));
setTimeout(() => process.exit(0), 90000);
`);
  const effects = path.join(project, "effects.txt");
  const args = { program: process.execPath, args: [fixture, "parent", String(server.address().port), effects] };
  control = spawn(process.execPath, [fixture, "unrelated", String(server.address().port)], {
    stdio: "ignore", env: { ...process.env, RHO_OPERATION_ID: "unrelated-native-control" },
  });
  controlEnded = once(control, "exit");
  host = spawn(binary, invocation("crashed-command", "process.run_local", args), { stdio: ["ignore", "ignore", "inherit"] });
  hostEnded = once(host, "exit");
  await deadline(Promise.race([waitPeers(3), hostEnded.then(() => { throw new Error("Host exited before readiness"); })]), 15_000, "workers did not start");
  const parent = peers.get("parent"), detached = peers.get("detached"), unrelated = peers.get("unrelated");
  const id = parent.operation_id;
  assert.match(id, /^op_[a-f0-9]{32}$/u);
  assert.equal(detached.operation_id, id);
  assert.equal(get(id).status, "running");
  host.kill("SIGKILL");
  await hostEnded;
  const beforeRead = fs.readFileSync(database);
  assert.equal(get(id).status, "running");
  assert.deepEqual(fs.readFileSync(database), beforeRead);
  const other = path.join(directory, "other-project"); fs.mkdirSync(other);
  const rejected = invoke("wrong-project", "process.reconcile", { operation_id: id }, ["--database", database, "--project", other]);
  assert.equal(rejected.status, "failed");
  const uncertain = get(id);
  assert.equal(uncertain.status, "uncertain");
  assert.equal(fs.readFileSync(effects, "utf8"), "executed once\n");
  const result = invoke("reconcile-command", "process.reconcile", { operation_id: id });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.output.no_matching_processes_observed, true);
  assert.equal(result.output.completeness, "partial");
  if (process.platform !== "win32") {
    const signalled = new Set(result.output.signalled.map((item) => item.pid));
    assert.ok(signalled.has(parent.pid), JSON.stringify(result));
    assert.ok(signalled.has(detached.pid), JSON.stringify(result));
    assert.ok(!signalled.has(unrelated.pid));
  }
  await deadline(Promise.all([parent.closed, detached.closed]), 5_000, "tagged worker survived reconciliation");
  assert.equal(unrelated.socket.destroyed, false, "unrelated process was terminated");
  assert.deepEqual(get(id), uncertain);
  assert.deepEqual(invoke("crashed-command", "process.run_local", args), uncertain);
  assert.deepEqual(invoke("reconcile-command", "process.reconcile", { operation_id: id }), result);
  assert.equal(fs.readFileSync(effects, "utf8"), "executed once\n");
  const again = invoke("observe-cleaned", "process.reconcile", { operation_id: id });
  assert.equal(again.status, "succeeded");
  assert.deepEqual(again.output.observed, []);
  console.log("Verified R-free CLI Host crash, tagged parent/detached-child cleanup, unrelated-process survival, immutable uncertainty and no re-execution.");
} finally {
  if (host && host.exitCode === null && host.signalCode === null) { host.kill("SIGKILL"); await hostEnded; }
  // Close only test-created workers over their own live fixture connections.
  for (const peer of peers.values()) if (!peer.socket.destroyed) peer.socket.write("stop\n");
  await deadline(Promise.all([...peers.values()].map((peer) => peer.closed)), 5_000, "fixture cleanup did not finish");
  if (control && control.exitCode === null && control.signalCode === null) { control.kill(); await controlEnded; }
  server.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
