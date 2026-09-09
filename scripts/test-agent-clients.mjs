import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const usage = `Usage:
  node scripts/test-agent-clients.mjs --real-model --provider codex
  node scripts/test-agent-clients.mjs --real-model --provider kimi --kimi-model MODEL --allow-overview
  node scripts/test-agent-clients.mjs --real-model --provider deepseek --deepseek-model '["PROVIDER","MODEL"]' --allow-overview
  node scripts/test-agent-clients.mjs --real-model --provider all --kimi-model MODEL --deepseek-model '["PROVIDER","MODEL"]' --allow-overview

Options:
  --real-model       Required opt-in to external model requests and CLI context.
  --provider NAME    codex, kimi, deepseek, or all (default: all).
  --kimi-model ID    Exact configured Kimi model ID; required when testing Kimi.
  --deepseek-model ID Exact opaque DeepSeek model ID from native discovery.
  --allow-overview   Authorize Kimi/DeepSeek to send temporary project and R
                    environment metadata, and approve that native tool once.
  --setup-component Explicitly install Rho's official DeepSeek ACP component
                    through the setup endpoint before discovery (if selected).
  --binary PATH     Built Rho executable (default: target/debug/rho).
  --help            Print this help without starting any process.

Uses installed, authenticated CLIs and their native model lists. Codex uses its
configured default model. No model service is called without --real-model.
The test creates a disposable project and Host, checks exact 'ok' replies and
request deduplication, and verifies Kimi/DeepSeek read Rho through native MCP.
It never approves other tools, retries an uncertain prompt, or edits user config.
CLI-native context still follows your existing CLI configuration. Build Rho first.
`;

function parseOptions(argv) {
  const options = { provider: "all", realModel: false, allowOverview: false, setupComponent: false,
    binary: path.join(root, "target/debug", process.platform === "win32" ? "rho.exe" : "rho") };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") return { help: true };
    if (arg === "--real-model") options.realModel = true;
    else if (arg === "--allow-overview") options.allowOverview = true;
    else if (arg === "--setup-component") options.setupComponent = true;
    else if (["--provider", "--kimi-model", "--deepseek-model", "--binary"].includes(arg)) {
      const value = argv[++i];
      assert.ok(value && !value.startsWith("--"), `${arg} requires a value`);
      options[{ "--provider": "provider", "--kimi-model": "kimiModel", "--deepseek-model": "deepseekModel", "--binary": "binary" }[arg]] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  assert.ok(options.realModel, "External tests require the explicit --real-model option.");
  assert.ok(["codex", "kimi", "deepseek", "all"].includes(options.provider), "--provider must be codex, kimi, deepseek, or all");
  options.providers = options.provider === "all" ? ["codex", "kimi", "deepseek"] : [options.provider];
  if (options.providers.includes("kimi")) {
    assert.ok(options.kimiModel, "Kimi acceptance requires --kimi-model with an exact configured model ID.");
    assert.ok(options.allowOverview, "Kimi acceptance requires --allow-overview for its read-only MCP check.");
  }
  if (options.providers.includes("deepseek")) {
    assert.ok(options.deepseekModel, "DeepSeek acceptance requires --deepseek-model with an exact opaque native model ID.");
    const route = JSON.parse(options.deepseekModel);
    assert.ok(Array.isArray(route) && route.length === 2 && route.every(value => typeof value === "string" && value.length > 0),
      "--deepseek-model must be the native JSON string containing [provider, model].");
    assert.ok(options.allowOverview, "DeepSeek acceptance requires --allow-overview for its read-only MCP check.");
  } else assert.ok(!options.setupComponent, "--setup-component requires --provider deepseek or all.");
  options.binary = path.resolve(options.binary);
  assert.ok(fs.existsSync(options.binary), `Build Rho first; executable missing: ${options.binary}`);
  return options;
}

async function run(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rho-agent-clients-"));
  fs.mkdirSync(path.join(dir, "study"));
  const project = fs.realpathSync(path.join(dir, "study"));
  fs.writeFileSync(path.join(project, "README.md"), "Synthetic native Agent acceptance project. Contains no research data.\n");
  const launchFile = path.join(dir, "launch.url");
  const windowId = `agent-acceptance-${randomUUID()}`;
  const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
  const watched = [...new Set([
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml"),
    path.join(os.homedir(), ".kimi-code/config.toml"),
    path.join(os.homedir(), ".kimi-code/mcp.json"),
    path.join(dshHome, "settings.yaml"),
    path.join(dshHome, ".credentials.yaml"),
  ])];
  const hashes = () => watched.map(file => fs.existsSync(file)
    ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null);
  const before = hashes();
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new Error("Acceptance interrupted; cleaning up owned processes."));
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const budget = options.setupComponent ? 540_000 : 360_000;
  const maximum = setTimeout(() => cancellation.abort(new Error(`Acceptance exceeded its ${budget / 60_000}-minute budget.`)), budget);
  let token = "", origin, window, sequence = 0, heartbeat, hostError, log = "";
  const clients = new Set();
  const safe = value => String(value)
    .replaceAll(token || "\u0000", "<private-token>")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer <private-token>")
    .replace(/([#?&]token=)[^&\s"']+/gi, "$1<private-token>")
    .slice(0, 2000);
  const report = data => console.log(safe(JSON.stringify(data)));
  const host = spawn(options.binary, ["--database", path.join(dir, "state.sqlite"),
    "--project", project, "workbench", "--url-file", launchFile], {
    cwd: project, stdio: ["ignore", "pipe", "pipe"],
  });
  host.stdout.on("data", () => {});
  host.stderr.on("data", data => { log = (log + data.toString()).slice(-4000); });
  const ended = new Promise(resolve => {
    host.once("exit", resolve);
    host.once("error", error => { hostError = error; resolve(); });
  });
  const checkActive = () => {
    cancellation.signal.throwIfAborted();
    if (hostError) throw hostError;
    if (host.exitCode !== null || host.signalCode !== null) throw new Error(`Acceptance Host exited. ${safe(log)}`);
  };
  const pause = async ms => {
    checkActive();
    await new Promise(resolve => setTimeout(resolve, ms));
    checkActive();
  };
  const api = async (route, body, timeout = 15_000, cleanup = false) => {
    if (!cleanup) checkActive();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Timed out: ${route}; request was not retried.`)), timeout);
    const onCancel = () => controller.abort(cancellation.signal.reason);
    if (!cleanup) cancellation.signal.addEventListener("abort", onCancel, { once: true });
    try {
      const response = await fetch(origin + route, {
        method: body ? "POST" : "GET", signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Rho-Studio-Window": windowId },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`${route}: HTTP ${response.status}: ${safe(JSON.stringify(data))}`);
      return data;
    } finally {
      clearTimeout(timer);
      cancellation.signal.removeEventListener("abort", onCancel);
    }
  };
  const bridge = params => api("/api/application/bridge", { project_root: project,
    frame: { id: String(++sequence), request: { method: "application_bridge", params } } });
  const action = (client, value, cleanup = false) => api("/api/agents/action", {
    project_root: project, window, session_id: client.id, action: value,
  }, cleanup ? 5000 : 15_000, cleanup);
  const reply = client => {
    const lastUser = client.messages.findLastIndex(message => message.role === "user");
    return client.messages.slice(lastUser + 1).filter(message => message.role === "assistant").at(-1)?.text.trim() || "";
  };
  const settled = async (client, requestId, { overview = false } = {}) => {
    const deadline = Date.now() + (overview ? 120_000 : 90_000);
    const decisions = new Set();
    let lastReady, readySince = 0;
    while (Date.now() < deadline) {
      await pause(200);
      client = await action(client, { kind: "read" });
      assert.equal(client.last_request_id, requestId, "Native session lost the submitted request identity");
      for (const decision of client.decisions) {
        const permissionOption = client.provider === "deepseek" ? "allow-once" : "approve_once";
        const overviewTool = client.provider === "deepseek"
          ? `mcp__rho__rho_host_overview_v1_${createHash("sha256").update("rho\0rho.host.overview.v1").digest("hex").slice(0, 12)}`
          : "mcp__rho__rho_host_overview_v1";
        assert.ok(overview && options.allowOverview
          && decision.title === overviewTool
          && decision.options.some(option => option.id === permissionOption),
        `Unexpected native permission request: ${decision.title}; no approval was sent`);
        if (!decisions.has(decision.id)) {
          decisions.add(decision.id);
          await action(client, { kind: "decision", id: decision.id, option: permissionOption });
          report({ provider: client.provider, phase: "approved-once", tool: decision.title });
        }
      }
      assert.ok(["running", "waiting_for_permission", "ready"].includes(client.state),
        `Native task ${client.state}: ${safe(client.error || "No successful completion")}`);
      // Native final deltas and the completion notification may arrive separately.
      // Observe a stable final projection; never resubmit to obtain a missing answer.
      if (client.state === "ready") {
        const snapshot = JSON.stringify([client.messages, client.elapsed_ms, client.error]);
        if (snapshot !== lastReady) { lastReady = snapshot; readySince = Date.now(); }
        else if (Date.now() - readySince >= 600) return client;
      } else { lastReady = undefined; readySince = 0; }
    }
    throw new Error(`Native ${overview ? "MCP task" : "model test"} timed out; request was not retried.`);
  };

  let failure;
  try {
    const startupDeadline = Date.now() + 30_000;
    while (!fs.existsSync(launchFile)) {
      if (Date.now() > startupDeadline) throw new Error("Acceptance Host startup timed out.");
      await pause(50);
    }
    const url = new URL(fs.readFileSync(launchFile, "utf8").trim());
    origin = url.origin;
    token = new URLSearchParams(url.hash.slice(1)).get("token") || "";
    assert.ok(token, "Host launch URL did not provide its private credential");
    const registration = await bridge({ kind: "register", window_id: windowId, incarnation: randomUUID(),
      label: "Native Agent acceptance", previous_session: null });
    const registered = registration.result.data.session;
    window = registered.window;
    let renewing = false;
    heartbeat = setInterval(async () => {
      if (renewing) return;
      renewing = true;
      try { await bridge({ kind: "renew", session: registered }); }
      catch (error) { cancellation.abort(error); }
      finally { renewing = false; }
    }, 5000);

    for (const provider of options.providers) {
      if (provider === "deepseek" && options.setupComponent) {
        const setupStarted = Date.now();
        const setup = await api("/api/agents/setup", { project_root: project, provider }, 225_000);
        assert.equal(setup.error, null, safe(setup.error));
        assert.equal(setup.setup_required, false, "DeepSeek setup did not report a ready component");
        report({ provider, phase: "component-setup", ms: Date.now() - setupStarted });
      }
      const requestedModel = provider === "kimi" ? options.kimiModel : provider === "deepseek" ? options.deepseekModel : null;
      const catalog = await api("/api/agents/discover", {
        project_root: project, provider, model: requestedModel,
      }, 45_000);
      assert.equal(catalog.error, null, safe(catalog.error));
      assert.ok(catalog.models.length > 0, `${provider} returned no native models`);
      if (requestedModel) assert.equal(catalog.selected_model, requestedModel);
      const selected = catalog.models.find(model => model.id === catalog.selected_model);
      assert.ok(selected, `${provider}'s selected model was absent from its native list`);
      const effort = selected.efforts.includes(catalog.selected_effort) ? catalog.selected_effort : selected.default_effort;
      report({ provider, phase: "models", count: catalog.models.length, model: selected.id, ms: catalog.discovery_ms });

      const started = Date.now();
      let client = await api("/api/agents/connect", { request_id: randomUUID(), project_root: project,
        window, provider, model: selected.id, effort }, 60_000);
      clients.add(client.id);
      assert.equal(client.state, "ready", safe(client.error));
      report({ provider, phase: "connected", ms: Date.now() - started });
      const requestId = randomUUID();
      const test = { kind: "test", request_id: requestId };
      await action(client, test);
      client = await settled(client, requestId);
      assert.equal(reply(client), "ok", `${provider} did not return the requested exact 'ok' reply`);
      report({ provider, phase: "model-test", model: client.model, ms: client.elapsed_ms, reply: "ok" });

      const projection = value => ({ messages: value.messages, elapsed_ms: value.elapsed_ms,
        state: value.state, last_request_id: value.last_request_id });
      assert.deepEqual(projection(await action(client, test)), projection(client), "Duplicate request changed the completed task");
      await pause(800);
      assert.deepEqual(projection(await action(client, { kind: "read" })), projection(client), "Duplicate request replayed a native task");
      report({ provider, phase: "request-deduplication", passed: true });

      if (provider === "kimi" || provider === "deepseek") {
        const beforeOverview = await api("/api/agent-connection");
        const served = new Map(beforeOverview.sessions.map(session => [session.connection_id, session.overview_served_at_ms]));
        const overviewId = randomUUID();
        await action(client, { kind: "prompt", request_id: overviewId,
          text: "Use the configured rho MCP tools to read host.overview. Return only the final directory name of its project_root, as plain text. Do not use shell, edit files, configure anything, or run R." });
        client = await settled(client, overviewId, { overview: true });
        const observed = await api("/api/agent-connection");
        const reads = observed.sessions.filter(session => session.overview_served_at_ms
          && session.overview_served_at_ms !== served.get(session.connection_id));
        assert.ok(reads.length > 0, `${provider} did not perform a new native Rho MCP overview read`);
        // This is a transport smoke check. The observed native MCP read proves
        // the connection; a short name avoids grading a long random temp path.
        assert.equal(reply(client), path.basename(project), `${provider} did not return the temporary project directory name`);
        report({ provider, phase: "native-mcp-overview", actualOverviewReads: reads.length,
          project_name_matches: true, ms: client.elapsed_ms });
      }
      await action(client, { kind: "disconnect" });
      clients.delete(client.id);
    }
  } catch (error) {
    failure = error;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(maximum);
    for (const id of clients) {
      try { await action({ id }, { kind: "disconnect" }, true); }
      catch { /* The owned Host's shutdown also closes its Agent clients. */ }
    }
    if (host.exitCode === null && host.signalCode === null && !hostError) {
      host.kill("SIGINT");
      const force = setTimeout(() => host.kill("SIGKILL"), 10_000);
      await ended;
      clearTimeout(force);
    }
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    try {
      assert.deepEqual(hashes(), before, "A watched user CLI configuration changed during acceptance");
      report({ phase: "user-configuration", unchanged: true });
    } catch (error) {
      report({ phase: "user-configuration", unchanged: false });
      failure ||= error;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failure) throw new Error(safe(failure.message || failure));
  report({ acceptance: "native-agent-clients", passed: true });
}

try {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) console.log(usage);
  else await run(options);
} catch (error) {
  console.error(`Native Agent acceptance failed: ${error.message}`);
  process.exitCode = 1;
}
