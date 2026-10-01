// Actual rmcp stdio server and generic plugin Host; no scientific provider required.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
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
assert.deepEqual(process.argv.slice(2), [], "Use ordinary-plugin suites for scientific acceptance");
let binary;
if (process.env.RHO_TEST_BINARY) {
  binary = fs.realpathSync(process.env.RHO_TEST_BINARY);
} else {
  run("cargo", ["build", "--manifest-path", "Cargo.toml", "-p", "rho-cli", "--locked", "--offline"]);
  const metadata = JSON.parse(run("cargo", ["metadata", "--manifest-path", "Cargo.toml", "--no-deps", "--format-version", "1", "--offline"]));
  binary = path.join(metadata.target_directory, "debug", process.platform === "win32" ? "rho.exe" : "rho");
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rho-mcp-"));
const project = path.join(dir, "project"); fs.mkdirSync(project);
const database = path.join(dir, "state/next.sqlite");
const base = ["--database", database, "--project", project];
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
const peer = client([...base, "mcp"]);
let oversized;
try {
  await initialize(peer);
  const tools = [];
  let cursor;
  const cursors = new Set();
  do {
    const page = await peer.request("tools/list", cursor ? { cursor } : {}).result;
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor) { assert.ok(!cursors.has(cursor), "Catalog cursor must advance"); cursors.add(cursor); }
  } while (cursor);
  function portableFormats(schema, tool) {
    if (!schema || typeof schema !== "object") return;
    assert.ok(typeof schema.format !== "string" || !/^(?:u?int(?:8|16|32|64|128)?|float|double)$/.test(schema.format),
      `${tool}: Rust numeric format ${schema.format} is not portable JSON Schema`);
    for (const [key, child] of Object.entries(schema)) {
      if (!["const", "enum", "examples", "default"].includes(key)) portableFormats(child, tool);
    }
  }
  for (const tool of tools) {
    portableFormats(tool.inputSchema, tool.name);
    portableFormats(tool.outputSchema, tool.name);
  }
  assert.deepEqual(tools.filter(tool => !["rho.workspace.paths.v1", "rho.events.poll"].includes(tool.name)
    && !/^rho\.(host|plugins|views|windows|scenarios|documents|resources|operation)\./.test(tool.name)).map(tool => tool.name), []);
  const queryTool = tools.find((tool) => tool.name === "rho.plugins.list.v1");
  assert.equal(queryTool.annotations.readOnlyHint, true);
  const commandTool = tools.find((tool) => tool.name === "rho.scenarios.checkpoint.v1");
  assert.deepEqual(commandTool.inputSchema.required, ["client_request_id", "arguments"]);
  const beforeEvents = (await peer.call("rho.events.poll", {}).result).structuredContent.result;
  const snapshot = (await peer.call(queryTool.name, { limit: 10 }).result).structuredContent.result;
  assert.equal(snapshot.status, "ready");
  assert.deepEqual((await peer.call("rho.events.poll", {}).result).structuredContent.result, beforeEvents);
  const input = { client_request_id: "mcp-checkpoint", arguments: {scenario: "mcp", expected_head: null, name: "MCP", instances: {}, providers: [], layout: {kind: "empty"}} };
  const patched = (await peer.call(commandTool.name, input).result).structuredContent.result;
  assert.equal(patched.status, "succeeded", JSON.stringify(patched));
  assert.equal(patched.operation.caller.kind, "agent");
  assert.equal(patched.operation.caller.id, "local-mcp");
  assert.equal(patched.operation.principal.kind, "human");
  assert.equal(patched.operation.principal.id, "local-user");

  assert.deepEqual((await peer.call(commandTool.name, input).result).structuredContent.result, patched);
  const humanRead = JSON.parse(run(binary, ["--database", database, "get-operation", patched.operation.operation_id]));
  const { next_reads: humanReads, ...humanRecord } = humanRead.operation;
  const { next_reads: agentReads, ...agentRecord } = patched;
  assert.deepEqual(humanRecord, agentRecord, "human edge cannot read Agent owner truth");
  assert.ok(humanReads.some(read => read.capability.id === "operation.get" && read.arguments.operation_id === patched.operation.operation_id));
  assert.ok(!humanReads.some(read => read.capability.id === "project.read_text"), "a journal-only reader must not advertise an unavailable owner");
  assert.ok(agentReads.some(read => read.capability.id === "operation.get"));
  const beforeInjection = (await peer.call("rho.events.poll", { limit: 1000 }).result).structuredContent.result;
  const injected = await peer.call(commandTool.name, { ...input, client_request_id: "spoof", principal: { id: "other-user" } }).result.catch((error) => ({ isError: true, error: String(error) }));
  assert.equal(injected.isError, true);
  assert.deepEqual((await peer.call("rho.events.poll", { limit: 1000 }).result).structuredContent.result, beforeInjection);

  peer.child.stdin.end();
  const [code] = await deadline(peer.ended, 10_000, "MCP did not drain Host work");
  assert.equal(code, 0);
  // Reopen the same generic Host: the exact MCP request returns its durable record.
  const reopened = client([...base, "mcp"]);
  try {
    await initialize(reopened);
    assert.deepEqual((await reopened.call(commandTool.name, input).result).structuredContent.result, patched);
    reopened.child.stdin.end();
    assert.equal((await deadline(reopened.ended, 10_000, "Reopened MCP did not stop"))[0], 0);
  } finally {
    reopened.lines.close();
    if (reopened.child.exitCode === null && reopened.child.signalCode === null) { reopened.child.kill(); await reopened.ended; }
  }
  oversized = client([...base, "mcp"]);
  await initialize(oversized);
  oversized.child.stdin.on("error", () => {});
  oversized.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: commandTool.name, arguments: { oversized: "x".repeat(300000) } } }) + "\n");
  await deadline(oversized.ended, 10_000, "oversized MCP frame did not close");
  oversized.lines.close();
  console.log("Verified actual rmcp handshake/discovery, registry schemas, query purity, Agent/human shared principal truth, checkpoint idempotency across actual Host restart, clean drain and bounded input.");
} finally {
  peer.lines.close();
  if (peer.child.exitCode === null && peer.child.signalCode === null) { peer.child.kill(); await peer.ended; }
  if (oversized && oversized.child.exitCode === null && oversized.child.signalCode === null) { oversized.child.kill(); await oversized.ended; }
  oversized?.lines.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
