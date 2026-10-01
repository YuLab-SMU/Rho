// Real generic Workbench HTTP/MCP and connected CLI; no scientific provider required.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.deepEqual(process.argv.slice(2), [], "No fixed runtime options; use ordinary-plugin suites for scientific acceptance");
function run(program, args) {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: "utf8",
    timeout: program === "cargo" ? 900_000 : 60_000,
  });
  assert.equal(
    result.status,
    0,
    result.error?.message || result.stderr || result.signal,
  );
  return result.stdout;
}
// An explicitly selected current binary avoids a redundant Cargo invocation.
// CI/default usage still builds the CLI before testing its real transports.
let binary;
if (process.env.RHO_TEST_BINARY) {
  binary = fs.realpathSync(process.env.RHO_TEST_BINARY);
} else {
  run("cargo", ["build", "--manifest-path", "Cargo.toml", "-p", "rho-cli", "--locked", "--offline"]);
  const metadata = JSON.parse(run("cargo", ["metadata", "--manifest-path", "Cargo.toml", "--no-deps", "--format-version", "1", "--offline"]));
  binary = path.join(metadata.target_directory, "debug", process.platform === "win32" ? "rho.exe" : "rho");
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rho-workbench-"));
const project = path.join(dir, "project");
fs.mkdirSync(project);
const other = path.join(dir, "other");
fs.mkdirSync(other);
const urlFile = path.join(dir, "launch-url");
const args = ["--database", path.join(dir, "state/next.sqlite")];
async function deadline(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const watcher = fs.watch(dir);
const child = spawn(binary, [...args, "workbench", "--url-file", urlFile], {
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (data) => {
  stderr += data;
});
const ended = once(child, "exit");
let url,
  sessionId,
  sequence = 0;
async function waitForLaunch() {
  while (
    !fs.existsSync(urlFile) ||
    !fs.readFileSync(urlFile, "utf8").endsWith("\n")
  ) {
    await Promise.race([
      once(watcher, "change"),
      ended.then(() => {
        throw new Error(`Host exited during launch: ${stderr}`);
      }),
    ]);
  }
  return new URL(fs.readFileSync(urlFile, "utf8").trim());
}
let headers;
let selectedRoot;
async function api(endpoint, body) {
  const response = await fetch(new URL(endpoint, url), {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}
async function host(method, params, extra = {}) {
  const reply = await api("/api/host", {
    project_root: selectedRoot,
    frame: { id: String(++sequence), request: { method, params } },
    ...extra,
  });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.result;
}
async function mcp(method, params, notification = false) {
  const id = ++sequence;
  const response = await fetch(new URL("/mcp", url), {
    method: "POST",
    headers: {
      ...headers,
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(notification ? {} : { id }),
      method,
      params,
    }),
  });
  if (response.headers.has("mcp-session-id"))
    sessionId = response.headers.get("mcp-session-id");
  if (notification) {
    assert.equal(response.status, 202);
    await response.body?.cancel();
    return;
  }
  assert.equal(
    response.status,
    200,
    await (response.status === 200 ? Promise.resolve("") : response.text()),
  );
  let message;
  if (response.headers.get("content-type")?.includes("application/json"))
    message = await response.json();
  else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!message) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`MCP SSE ended without ${id}`);
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (data) {
            const parsed = JSON.parse(data);
            if (parsed.id === id) {
              message = parsed;
              break;
            }
          }
        }
      }
    } finally {
      await reader.cancel();
    }
  }
  assert.equal(message.id, id);
  assert.equal(message.error, undefined, JSON.stringify(message));
  return message.result;
}
try {
  url = await deadline(
    waitForLaunch(),
    20_000,
    "workbench did not produce a launch URL",
  );
  watcher.close();
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(url.searchParams.has("plugin-window"));
  if (process.platform !== "win32")
    assert.equal(fs.statSync(urlFile).mode & 0o777, 0o600);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  assert.ok(token);
  headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Origin: url.origin,
  };
  const publicShell = await fetch(new URL("/", url));
  assert.equal(publicShell.status, 200);
  assert.equal(publicShell.headers.get("cache-control"), "no-store");
  assert.ok(!(await publicShell.text()).includes(token));
  assert.equal((await fetch(new URL("/api/info", url))).status, 401);
  assert.equal((await fetch(new URL("/api/agent-connection", url))).status, 401);
  assert.equal((await fetch(new URL("/api/agent-connection", url), {
    headers: { ...headers, Origin: "https://foreign.example" },
  })).status, 403);
  assert.equal((await fetch(new URL("/mcp", url))).status, 401);
  assert.equal(
    (
      await fetch(new URL("/api/info", url), {
        headers: { ...headers, Origin: "https://foreign.example" },
      })
    ).status,
    403,
  );
  // Fetch may normalize Host; send the actual hostile header on the HTTP wire.
  const wrongHost = await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: "/api/info",
        headers: { ...headers, Host: "foreign.example" },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end();
  });
  assert.equal(wrongHost, 403);
  const empty = await api("/api/info");
  assert.equal(empty.project_root, null);
  assert.equal(empty.runtime, "plugins");
  assert.deepEqual(empty.capabilities, []);
  const noProjectConnection = await api("/api/agent-connection");
  assert.equal(noProjectConnection.project_root, null);
  assert.equal(noProjectConnection.active_sessions, 0);
  assert.deepEqual(noProjectConnection.sessions, []);
  assert.equal(noProjectConnection.endpoint, `${url.origin}/mcp`);
  assert.ok(!JSON.stringify(noProjectConnection).includes(token));
  selectedRoot = (await api("/api/project", { project_root: project }))
    .project_root;
  assert.equal(selectedRoot, fs.realpathSync(project));
  const history = () => host("subscribe", { after_sequence: 0, limit: 1000 });
  const before = await history();
  const snapshot = await host("query_snapshot", {
    capability: { id: "plugins.list", version: 1 },
    arguments: {after: null, limit: 10},
  });
  assert.equal(snapshot.status, "ready");
  assert.deepEqual(await history(), before);
  const connected = JSON.parse(run(binary, ["--connect-url-file", urlFile,
    "--project", selectedRoot, "query", "--capability", "host.overview"]));
  assert.equal(connected.ok, true);
  assert.equal(connected.observation.data.project_root, selectedRoot);
  const connectedRecord = JSON.parse(run(binary, ["--connect-url-file", urlFile,
    "invoke", "--client-request-id", "connected-cli-once", "--capability", "scenarios.checkpoint",
    "--arguments", JSON.stringify({scenario: "connected-cli", expected_head: null, name: "Connected CLI", instances: {}, providers: [], layout: {kind: "empty"}})])).operation;
  assert.equal(connectedRecord.status, "succeeded");
  const connectedHistory = await history();
  assert.ok(connectedHistory.some(event => event.operation_id === connectedRecord.operation.operation_id));
  assert.deepEqual(await host("get_operation", { operation_id: connectedRecord.operation.operation_id }), connectedRecord);
  const applicationBaseline = await history();
  const draftText = "界\n".repeat(8192);
  const initial = await api("/api/state/read", {project_root: selectedRoot, key: "transport-fixture"});
  const stateWrite = {project_root: selectedRoot, state: {...initial, value: {draft: draftText}}};
  const savedState = await api("/api/state/write", stateWrite);
  assert.equal(savedState.value.draft, draftText);
  assert.deepEqual(await api("/api/state/read", {project_root: selectedRoot, key: initial.key}), savedState);
  assert.equal(await fetch(new URL("/api/state/write", url), {method: "POST", headers, body: JSON.stringify(stateWrite)}).then(reply => reply.status), 409);
  const oversizedBody = JSON.stringify({project_root: selectedRoot, frame: {id: "oversized",
    request: {method: "query_snapshot", params: {capability: {id: "plugins.list", version: 1}, arguments: {padding: "x".repeat(300 * 1024)}}}}});
  // The bound can reject Content-Length before reading bytes. Waiting for Continue
  // avoids racing a still-writing fetch body against the server closing the socket;
  // this still requires an actual 413, never an accepted connection-reset fallback.
  const oversizedStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(new URL("/api/host", url), {
      method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(oversizedBody), Expect: "100-continue" },
    }, response => {
      response.resume(); response.once("end", () => { resolve(response.statusCode); request.destroy(); });
    });
    request.once("error", reject);
    request.setTimeout(10000, () => request.destroy(new Error("Oversized request did not receive a response")));
    request.once("continue", () => request.end(oversizedBody));
    request.flushHeaders();
  });
  assert.equal(oversizedStatus, 413);
  for (const endpoint of ["/api/application/bridge", "/api/r", "/api/r/probe"]) {
    assert.equal(await fetch(new URL(endpoint, url), {
      method: "POST", headers, body: "{}",
    }).then(response => response.status), 404);
  }
  assert.deepEqual(await history(), applicationBaseline, "Generic state persistence must not write operation history");
  const beforeMcp = await api("/api/agent-connection");
  assert.equal(beforeMcp.active_sessions, 0, "Studio and connected CLI reads are not MCP connections");
  assert.deepEqual(beforeMcp.sessions, []);
  const hello = await mcp("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "workbench-fixture", version: "1" },
  });
  assert.equal(hello.serverInfo.name, "rho");
  assert.ok(sessionId);
  await mcp("notifications/initialized", {}, true);
  const tools = [], cursors = new Set();
  let cursor;
  do {
    const page = await mcp("tools/list", cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor) { assert.ok(!cursors.has(cursor), "MCP catalog cursor must advance"); cursors.add(cursor); }
  } while (cursor);
  assert.ok(tools.some(tool => tool.name === "rho.plugins.list.v1"));
  // workspace.paths is the generic project containment observation, not an R owner.
  const fixedTools = tools.filter(tool => !["rho.workspace.paths.v1", "rho.events.poll"].includes(tool.name)
    && !/^rho\.(host|plugins|views|windows|scenarios|documents|resources|operation)\./.test(tool.name));
  assert.deepEqual(fixedTools.map(tool => tool.name), [], "Empty generic Host must not expose fixed scientific owners");
  assert.equal(
    (
      await fetch(new URL("/api/project", url), {
        method: "POST",
        headers,
        body: JSON.stringify({ project_root: other }),
      })
    ).status,
    409,
  );
  const call = (name, arguments_) =>
    mcp("tools/call", { name, arguments: arguments_ }).then((reply) => {
      assert.ok(!reply.isError, JSON.stringify(reply));
      return reply.structuredContent.result;
    });
  const initializedConnection = await api("/api/agent-connection");
  assert.equal(initializedConnection.active_sessions, 1);
  assert.equal(initializedConnection.sessions.length, 1);
  assert.equal(initializedConnection.sessions[0].client_reported_name, "workbench-fixture");
  assert.equal(initializedConnection.sessions[0].overview_served_at_ms, null);
  assert.ok(!("window_contexts" in initializedConnection.sessions[0]));
  assert.ok(!JSON.stringify(initializedConnection).includes(sessionId), "Private MCP transport ID is not exposed");
  await call("rho.host.overview.v1", {});
  const servedConnection = await api("/api/agent-connection");
  assert.equal(servedConnection.project_root, selectedRoot);
  assert.ok(servedConnection.sessions[0].overview_served_at_ms);
  assert.ok(!("window_contexts" in servedConnection.sessions[0]));
  assert.ok(!JSON.stringify(servedConnection).includes(token));
  assert.deepEqual(await history(), applicationBaseline, "Connection observations must not create scientific operations");
  const checkpoint = {client_request_id: "agent-http", arguments: {
    scenario: "mcp-fixture", expected_head: null, name: "MCP fixture", instances: {}, providers: [], layout: {kind: "empty"},
  }};
  const fromAgent = await call("rho.scenarios.checkpoint.v1", checkpoint);
  assert.deepEqual(await call("rho.scenarios.checkpoint.v1", checkpoint), fromAgent);
  assert.equal(fromAgent.status, "succeeded");
  assert.equal(fromAgent.operation.caller.kind, "agent");
  assert.deepEqual(
    await host("get_operation", {
      operation_id: fromAgent.operation.operation_id,
    }),
    fromAgent,
  );
  const detached = await fetch(new URL("/mcp", url), {
    method: "DELETE",
    headers: {
      ...headers,
      "Mcp-Session-Id": sessionId,
      "MCP-Protocol-Version": "2025-11-25",
    },
  });
  assert.equal(detached.status, 202);
  await detached.body?.cancel();
  sessionId = undefined;
  const closedConnection = await deadline((async () => {
    for (;;) {
      const observed = await api("/api/agent-connection");
      if (observed.active_sessions === 0) return observed;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  })(), 5000, "MCP connection closure was not observed");
  assert.ok(closedConnection.sessions[0].closed_at_ms);
  assert.ok(closedConnection.sessions[0].overview_served_at_ms, "Closing a connection retains bounded evidence");
  const changed = await api("/api/project", { project_root: other });
  assert.equal(changed.project_root, fs.realpathSync(other));
  const replacedConnection = await api("/api/agent-connection");
  assert.equal(replacedConnection.project_root, changed.project_root);
  assert.equal(replacedConnection.active_sessions, 0);
  assert.deepEqual(replacedConnection.sessions, [], "A replacement Host must not inherit old connection evidence");
  const stale = await fetch(new URL("/api/host", url), {
    method: "POST",
    headers,
    body: JSON.stringify({
      project_root: selectedRoot,
      frame: {
        id: "stale",
        request: {
          method: "subscribe",
          params: { after_sequence: 0, limit: 10 },
        },
      },
    }),
  });
  assert.equal(stale.status, 409);
  child.kill("SIGINT");
  assert.deepEqual(await deadline(ended, 10_000, "Host did not stop"), [
    0,
    null,
  ]);
  console.log(
    "Verified generic HTTP/MCP/connected CLI, checkpoint idempotency, state CAS, bounded requests, pure observations and project-switch fencing; no fixed scientific owners.",
  );
} finally {
  watcher.close();
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGINT");
    await deadline(ended, 10_000, "test Host did not stop").catch(async () => {
      child.kill("SIGKILL");
      await ended;
    });
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
