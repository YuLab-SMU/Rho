// Actual rmcp stdio server, local filesystem/process operations; no remote target.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (program, args) => {
  const result = spawnSync(program, args, { cwd: root, encoding: "utf8", timeout: program === "cargo" ? 900_000 : 60_000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.signal);
  return result.stdout;
};
run("cargo", ["build", "--manifest-path", "Cargo.toml", "-p", "rho-cli", "--locked", "--offline"]);
const metadata = JSON.parse(run("cargo", ["metadata", "--manifest-path", "Cargo.toml", "--no-deps", "--format-version", "1", "--offline"]));
const binary = path.join(metadata.target_directory, "debug", process.platform === "win32" ? "rho.exe" : "rho");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rho-mcp-"));
const project = path.join(dir, "project"); fs.mkdirSync(project);
fs.writeFileSync(path.join(project, "analysis.R"), "x <- 1\n");
const database = path.join(dir, "state/next.sqlite");
const base = ["--database", database, "--project", project];
const realR = process.argv.includes("--real-r");
let humanPlan;
let hosting = base;
if (realR) {
  const rHome = process.env.RHO_R_HOME || run("Rscript", ["--vanilla", "-e", "cat(R.home())"]).trim();
  const ark = process.env.RHO_ARK || path.resolve(root, "target/debug", process.platform === "win32" ? "ark.exe" : "ark");
  assert.ok(fs.existsSync(ark), "real MCP acceptance needs an installed Ark");
  fs.cpSync(path.join(root, "crates/host/tests/fixtures/rhonextfixture"), path.join(project, "pkg"), { recursive: true });
  const rscript = path.join(rHome, "bin", process.platform === "win32" ? "Rscript.exe" : "Rscript");
  humanPlan = JSON.parse(run(binary, [...base, "--rscript", rscript, "invoke", "--client-request-id", "human-plan",
    "--capability", "environment.plan", "--arguments", JSON.stringify({ manager: "pak", packages: ["local::pkg"] })])).operation;
  assert.equal(humanPlan.status, "succeeded");
  hosting = [...base, "--ark", ark, "--r-home", rHome];
}

async function deadline(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
function client(args) {
  const child = spawn(binary, args, { stdio: ["pipe", "pipe", "inherit"] });
  const ended = once(child, "exit");
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0;
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, "2.0", "non-MCP stdout output");
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  ended.then(() => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("MCP transport closed")); }
    pending.clear();
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const request = (method, params) => {
    const id = ++sequence;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, 15_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    return { id, result };
  };
  return { child, ended, lines, notify, request, call: (name, args) => request("tools/call", { name, arguments: args }) };
}
async function initialize(peer) {
  const hello = await peer.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "not-an-authority", version: "1" } }).result;
  assert.equal(hello.serverInfo.name, "rho");
  peer.notify("notifications/initialized", {});
}
const peer = client([...hosting, "mcp"]);
const sockets = [];
let marker, oversized;
try {
  await initialize(peer);
  const tools = (await peer.request("tools/list", {}).result).tools;
  assert.ok(tools.some((tool) => tool.name === "rho.project.apply_patch.v1"));
  const queryTool = tools.find((tool) => tool.name === "rho.project.snapshot.v1");
  assert.equal(queryTool.annotations.readOnlyHint, true);
  const commandTool = tools.find((tool) => tool.name === "rho.project.apply_patch.v1");
  assert.deepEqual(commandTool.inputSchema.required, ["client_request_id", "arguments"]);
  const beforeEvents = (await peer.call("rho.events.poll", {}).result).structuredContent.result;
  const snapshot = (await peer.call(queryTool.name, { paths: ["analysis.R"] }).result).structuredContent.result;
  assert.equal(snapshot.status, "ready");
  assert.deepEqual((await peer.call("rho.events.poll", {}).result).structuredContent.result, beforeEvents);
  const input = { client_request_id: "mcp-patch", arguments: { patch: "--- a/analysis.R\n+++ b/analysis.R\n@@ -1 +1 @@\n-x <- 1\n+x <- 2\n" } };
  const patched = (await peer.call(commandTool.name, input).result).structuredContent.result;
  assert.equal(patched.status, "succeeded", JSON.stringify(patched));
  assert.equal(patched.operation.caller.kind, "agent");
  assert.equal(patched.operation.caller.id, "local-mcp");
  assert.equal(patched.operation.principal.kind, "human");
  assert.equal(patched.operation.principal.id, "local-user");
  assert.equal(fs.readFileSync(path.join(project, "analysis.R"), "utf8"), "x <- 2\n");
  assert.deepEqual((await peer.call(commandTool.name, input).result).structuredContent.result, patched);
  const humanRead = JSON.parse(run(binary, ["--database", database, "get-operation", patched.operation.operation_id]));
  assert.deepEqual(humanRead.operation, patched, "human edge cannot read Agent owner truth");
  const beforeInjection = (await peer.call("rho.events.poll", { limit: 1000 }).result).structuredContent.result;
  const injected = await peer.call(commandTool.name, { ...input, client_request_id: "spoof", principal: { id: "other-user" } }).result.catch((error) => ({ isError: true, error: String(error) }));
  assert.equal(injected.isError, true);
  assert.deepEqual((await peer.call("rho.events.poll", { limit: 1000 }).result).structuredContent.result, beforeInjection);

  if (realR) {
    const executed = (await peer.call("rho.workspace.run_r.v1", { client_request_id: "mcp-real-r", arguments: { code: "x <- 21; x * 2" } }).result).structuredContent.result;
    assert.equal(executed.status, "succeeded", JSON.stringify(executed));
    assert.equal(executed.output.value, 42);
    for (const capability of ["help", "lint", "format"]) {
      assert.ok(tools.some((tool) => tool.name === `rho.workspace.${capability}.v1`));
    }
    const help = (await peer.call("rho.workspace.help.v1", { client_request_id: "mcp-help", arguments: { topic: "mean" } }).result).structuredContent.result;
    assert.equal(help.status, "succeeded", JSON.stringify(help));
    assert.equal(help.output.value.found, true);
    assert.equal(help.operation.target.identity, executed.operation.target.identity);
    const history = (await peer.call("rho.events.poll", { limit: 1000 }).result).structuredContent.result;
    const inspected = (await peer.call("rho.workspace.inspect_object.v1", { name: "x", max_items: 3 }).result).structuredContent.result;
    assert.deepEqual(inspected.data.preview, [21]);
    assert.deepEqual((await peer.call("rho.events.poll", { limit: 1000 }).result).structuredContent.result, history);
    const realized = (await peer.call("rho.environment.realize.v1", { client_request_id: "mcp-realize-human-plan",
      arguments: { plan_operation_id: humanPlan.operation.operation_id } }).result).structuredContent.result;
    assert.equal(realized.status, "succeeded", JSON.stringify(realized));
    assert.equal(realized.output.verified, true);
    assert.equal(realized.operation.caller.kind, "agent");
    assert.equal(realized.output.plan_operation_id, humanPlan.operation.operation_id);
    assert.deepEqual(JSON.parse(run(binary, ["--database", database, "get-operation", realized.operation.operation_id])).operation, realized);
    console.log("Verified real Ark/R execution and Query through MCP, plus Agent realization of a Human-created environment plan under one principal.");
  }

  marker = net.createServer(); marker.listen(0, "127.0.0.1"); await once(marker, "listening");
  async function longOperation(id, body) {
    const started = new Promise((resolve) => marker.once("connection", (socket) => {
      sockets.push(socket); socket.on("error", () => {});
      socket.once("data", (data) => resolve(data.toString().trim()));
    }));
    const code = `const net=require('node:net'); const s=net.connect(${marker.address().port},'127.0.0.1',()=>{s.write(process.env.RHO_OPERATION_ID+'\\n'); ${body}});`;
    const call = peer.call("rho.process.run_local.v1", { client_request_id: id, arguments: { program: process.execPath, args: ["-e", code] } });
    call.result.catch(() => {});
    const operationId = await deadline(Promise.race([started, call.result.then((value) => { throw new Error(`operation ended before readiness: ${JSON.stringify(value)}`); })]), 10_000, "native process did not start");
    return { call, operationId };
  }
  const cancellable = await longOperation("cancel-me", "setInterval(()=>{},1000);");
  const cancellation = (await peer.call("rho.operation.request_cancellation", { operation_id: cancellable.operationId }).result).structuredContent.result;
  assert.equal(cancellation.accepted, true);
  const cancelled = (await cancellable.call.result).structuredContent.result;
  assert.equal(cancelled.status, "cancelled");
  const effect = path.join(project, "after-disconnect.txt");
  const detached = await longOperation("keep-after-disconnect", `setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(effect)},'committed');s.end();},500);`);
  peer.notify("notifications/cancelled", { requestId: detached.call.id, reason: "stop waiting only" });
  peer.child.stdin.end();
  const [code] = await deadline(peer.ended, 10_000, "MCP did not drain Host work");
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(effect, "utf8"), "committed");
  const saved = JSON.parse(run(binary, ["--database", database, "get-operation", detached.operationId])).operation;
  assert.equal(saved.status, "succeeded");
  assert.equal(saved.cancellation_requested, false);
  oversized = client([...base, "mcp"]);
  await initialize(oversized);
  oversized.child.stdin.on("error", () => {});
  oversized.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: commandTool.name, arguments: { oversized: "x".repeat(300000) } } }) + "\n");
  await deadline(oversized.ended, 10_000, "oversized MCP frame did not close");
  oversized.lines.close();
  console.log("Verified actual rmcp handshake/discovery, registry schemas, query purity, Agent/human shared principal truth, invocation idempotency, explicit cancellation, disconnect drain and bounded input.");
} finally {
  for (const socket of sockets) socket.destroy();
  marker?.close(); peer.lines.close();
  if (peer.child.exitCode === null && peer.child.signalCode === null) { peer.child.kill(); await peer.ended; }
  if (oversized && oversized.child.exitCode === null && oversized.child.signalCode === null) { oversized.child.kill(); await oversized.ended; }
  oversized?.lines.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
