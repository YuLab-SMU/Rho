import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import readline from "node:readline";

export async function verifySession(binary, args) {
  const child = spawn(binary, [...args, "session"], { stdio: ["pipe", "pipe", "inherit"] });
  const ended = once(child, "exit");
  const lines = readline.createInterface({ input: child.stdout });
  const waiting = new Map();
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "ready") { resolveReady(message); return; }
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error));
  });
  const request = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`session request ${id} timed out`));
    }, 15_000);
    waiting.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, request: { method, params } }) + "\n");
  });
  // A managed Host routes every live R request to an explicit instance.
  const instance = "main";
  const invoke = (id, code) => request(id, "invoke", {
    client_request_id: id, capability: { id: "workspace.run_r", version: 1 },
    arguments: { workspace_instance_id: instance, code },
  });
  const query = (id, capability, args) => request(id, "query_snapshot", {
    capability: { id: capability, version: 1 }, arguments: { workspace_instance_id: instance, ...args },
  });
  const watchdog = setTimeout(() => child.kill(), 60_000);
  let marker;
  try {
    await Promise.race([ready, ended.then(() => { throw new Error("session exited before ready"); })]);
    const first = await invoke("create", "x <- 7; x");
    assert.equal(first.output.value, 7);
    const history = await request("history", "subscribe", { after_sequence: 0, limit: 1000 });
    const snapshot = await query("snapshot", "workspace.snapshot", {});
    assert.equal(snapshot.status, "ready");
    assert.ok(snapshot.data.objects.some((object) => object.name === "x"));
    const inspected = await query("inspect", "workspace.inspect_object", { name: "x" });
    assert.deepEqual(inspected.data.preview, [7]);
    const afterQueries = await request("history-after", "subscribe", { after_sequence: 0, limit: 1000 });
    assert.deepEqual(afterQueries, history);
    const second = await invoke("increment", "x <- x + 1; x");
    assert.equal(second.output.value, 8);
    assert.deepEqual(second.operation.target, first.operation.target);
    const saved = await request("read", "get_operation", { operation_id: first.operation.operation_id });
    assert.deepEqual(saved, first);

    marker = net.createServer();
    marker.listen(0, "127.0.0.1");
    await once(marker, "listening");
    const started = new Promise((resolve) => marker.once("connection", (socket) => {
      socket.once("data", () => { socket.end(); resolve(); });
    }));
    const long = invoke("long", `con <- socketConnection('127.0.0.1', port=${marker.address().port}, open='w'); writeLines('started', con); close(con); Sys.sleep(20); 123`);
    // Install a rejection handler now, while waiting for the signal from actual R.
    long.catch(() => {});
    await Promise.race([started, long.then(() => { throw new Error("long operation ended before its start signal"); })]);
    assert.equal((await query("busy", "workspace.snapshot", {})).status, "busy");
    const events = await request("running-events", "subscribe", { after_sequence: 0, limit: 1000 });
    const active = events.filter((event) => event.topic === "operation.accepted").at(-1).operation_id;
    assert.equal((await request("cancel", "request_cancellation", { operation_id: active })).accepted, true);
    assert.equal((await long).status, "cancelled");
    assert.equal((await query("after-cancel", "workspace.inspect_object", { name: "x" })).data.preview[0], 8);
    child.stdin.end();
    const [code, signal] = await ended;
    assert.equal(code, 0, `session ended with signal ${signal}`);
    console.log("Verified persistent CLI session: shared R state, read-only queries, busy response, cancellation and EOF shutdown.");
  } finally {
    clearTimeout(watchdog);
    for (const pending of waiting.values()) clearTimeout(pending.timer);
    marker?.close();
    lines.close();
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await ended; }
  }
}
