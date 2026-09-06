// Real local HTTP server and rmcp transport. Optional actual Ark/R. No remote service.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
run("cargo", [
  "build",
  "--manifest-path",
  "Cargo.toml",
  "-p",
  "rho-cli",
  "--locked",
  "--offline",
]);
const metadata = JSON.parse(
  run("cargo", [
    "metadata",
    "--manifest-path",
    "Cargo.toml",
    "--no-deps",
    "--format-version",
    "1",
    "--offline",
  ]),
);
const binary = path.join(
  metadata.target_directory,
  "debug",
  process.platform === "win32" ? "rho.exe" : "rho",
);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rho-workbench-"));
const project = path.join(dir, "project");
fs.mkdirSync(project);
const other = path.join(dir, "other");
fs.mkdirSync(other);
const urlFile = path.join(dir, "launch-url");
const args = ["--database", path.join(dir, "state/next.sqlite")];
const realR = process.argv.includes("--real-r");
if (realR) {
  const rHome =
    process.env.RHO_R_HOME ||
    run("Rscript", ["--vanilla", "-e", "cat(R.home())"]).trim();
  const ark =
    process.env.RHO_ARK ||
    path.resolve(
      root,
      "target/debug",
      process.platform === "win32" ? "ark.exe" : "ark",
    );
  assert.ok(fs.existsSync(ark), "real workbench acceptance requires Ark");
  args.push("--ark", ark, "--r-home", rHome);
}
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
const marker = net.createServer();
const sockets = [];
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
  assert.deepEqual(empty.capabilities, []);
  selectedRoot = (await api("/api/project", { project_root: project }))
    .project_root;
  assert.equal(selectedRoot, fs.realpathSync(project));
  const history = () => host("subscribe", { after_sequence: 0, limit: 1000 });
  const before = await history();
  const snapshot = await host("query_snapshot", {
    capability: { id: "project.snapshot", version: 1 },
    arguments: {},
  });
  assert.equal(snapshot.status, "ready");
  assert.deepEqual(await history(), before);
  const hello = await mcp("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "workbench-fixture", version: "1" },
  });
  assert.equal(hello.serverInfo.name, "rho");
  assert.ok(sessionId);
  await mcp("notifications/initialized", {}, true);
  assert.ok(
    (await mcp("tools/list", {})).tools.some(
      (t) => t.name === "rho.project.snapshot.v1",
    ),
  );
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
  const fromAgent = await call("rho.process.run_local.v1", {
    client_request_id: "agent-http",
    arguments: {
      program: process.execPath,
      args: ["-e", "process.stdout.write('42')"],
    },
  });
  assert.equal(fromAgent.status, "succeeded");
  assert.equal(fromAgent.operation.caller.kind, "agent");
  assert.deepEqual(
    await host("get_operation", {
      operation_id: fromAgent.operation.operation_id,
    }),
    fromAgent,
  );
  if (realR) {
    const input = {
      client_request_id: "ui-real-r",
      capability: { id: "workspace.run_r", version: 1 },
      arguments: { code: "x <- 21; x * 2" },
      preconditions: [],
    };
    const record = await host("invoke", input);
    assert.equal(record.status, "succeeded");
    assert.equal(record.output.value, 42);
    assert.deepEqual(await host("invoke", input), record);
    const queriedBefore = await history();
    const object = await call("rho.workspace.inspect_object.v1", {
      name: "x",
      max_items: 3,
    });
    assert.deepEqual(object.data.preview, [21]);
    assert.deepEqual(await history(), queriedBefore);
    const observed = await host("query_snapshot", {
      capability: { id: "environment.observe", version: 1 },
      arguments: { limit: 10 },
    });
    assert.equal(observed.status, "ready");
    assert.ok(observed.data.r_version);
  }
  marker.listen(0, "127.0.0.1");
  await once(marker, "listening");
  const started = new Promise((resolve) =>
    marker.once("connection", (socket) => {
      sockets.push(socket);
      socket.on("error", () => {});
      socket.once("data", (data) => resolve(data.toString().trim()));
    }),
  );
  const running = host("invoke", {
    client_request_id: "http-cancel",
    capability: { id: "process.run_local", version: 1 },
    arguments: {
      program: process.execPath,
      args: [
        "-e",
        `const s=require('node:net').connect(${marker.address().port},'127.0.0.1',()=>s.write(process.env.RHO_OPERATION_ID+'\\n'));setInterval(()=>{},1000);`,
      ],
    },
    preconditions: [],
  });
  const id = await deadline(
    Promise.race([
      started,
      running.then((r) => {
        throw new Error(`process did not start: ${JSON.stringify(r)}`);
      }),
    ]),
    10_000,
    "process start not observed",
  );
  const cancellation = await call("rho.operation.request_cancellation", {
    operation_id: id,
  });
  assert.equal(cancellation.accepted, true);
  assert.equal((await running).status, "cancelled");
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
  const effect = path.join(project, "after-http-disconnect.txt");
  const detachedStarted = new Promise((resolve) =>
    marker.once("connection", (socket) => {
      sockets.push(socket);
      socket.on("error", () => {});
      socket.once("data", (data) =>
        resolve({ id: data.toString().trim(), socket }),
      );
    }),
  );
  const detachedInput = {
    client_request_id: "http-disconnect",
    capability: { id: "process.run_local", version: 1 },
    arguments: {
      program: process.execPath,
      args: [
        "-e",
        `const s=require('node:net').connect(${marker.address().port},'127.0.0.1',()=>s.write(process.env.RHO_OPERATION_ID+'\\n'));s.once('data',()=>{require('node:fs').writeFileSync(${JSON.stringify(effect)},'once');s.end();});`,
      ],
    },
    preconditions: [],
  };
  const abort = new AbortController();
  const abandoned = fetch(new URL("/api/host", url), {
    method: "POST",
    headers,
    signal: abort.signal,
    body: JSON.stringify({
      project_root: selectedRoot,
      frame: {
        id: "abandon",
        request: { method: "invoke", params: detachedInput },
      },
    }),
  });
  abandoned.catch(() => {});
  const native = await deadline(
    Promise.race([
      detachedStarted,
      abandoned.then(() => {
        throw new Error("process ended before start");
      }),
    ]),
    10_000,
    "detached operation did not start",
  );
  abort.abort();
  await assert.rejects(abandoned, { name: "AbortError" });
  const whileRunning = await fetch(new URL("/api/project", url), {
    method: "POST",
    headers,
    body: JSON.stringify({ project_root: other }),
  });
  assert.equal(
    whileRunning.status,
    409,
    "disconnect must not release a live Host for project switching",
  );
  native.socket.write("finish");
  const saved = await deadline(
    (async () => {
      for (let attempt = 0; attempt < 128; attempt++) {
        const record = await host("get_operation", { operation_id: native.id });
        if (record?.outcome) return record;
      }
      throw new Error("no committed result after native process finished");
    })(),
    10_000,
    "disconnected work did not commit",
  );
  assert.equal(saved.status, "succeeded");
  assert.equal(saved.cancellation_requested, false);
  assert.equal(fs.readFileSync(effect, "utf8"), "once");
  assert.deepEqual(await host("invoke", detachedInput), saved);
  const changed = await api("/api/project", { project_root: other });
  assert.equal(changed.project_root, fs.realpathSync(other));
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
    `Verified local HTTP boundary, project selection/switch fence, pure queries, shared UI/MCP principal, cancellation and disconnect commit${realR ? ", plus actual Ark/R and Environment observations" : ""}.`,
  );
} finally {
  watcher.close();
  sockets.forEach((s) => s.destroy());
  marker.close();
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGINT");
    await deadline(ended, 10_000, "test Host did not stop").catch(async () => {
      child.kill("SIGKILL");
      await ended;
    });
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
