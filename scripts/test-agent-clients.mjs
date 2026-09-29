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
The test creates a disposable project and Host, checks two concurrent same-model tasks, exact replies, native continuation and
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
    "--project", project, "--fixed-workspace", "workbench", "--url-file", launchFile], {
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
  const query = query => api("/api/agents/tasks/query", { project_root: project, query });
  const control = d => ({ task_id: d.summary.task.task_id, generation: d.summary.attachment.generation });
  const command = (command, request_id = randomUUID(), cleanup = false) => api("/api/agents/tasks/command", {
    project_root: project, window, request_id, command,
  }, cleanup ? 5000 : 15_000, cleanup);
  const detail = async id => (await query({ kind: "get", task_id: id })).detail;
  const events = async id => (await query({ kind: "events", task_id: id, after: null, before: null, limit: 100 })).page.events;
  const reply = async (id, requestId) => (await events(id)).filter(e => e.request_id === requestId && e.role === "assistant" && e.text.trim()).at(-1)?.text.trim() || "";
  const settled = async (id, requestId, { overview = false } = {}) => {
    const deadline = Date.now() + (overview ? 120_000 : 90_000);
    const decisions = new Set();
    while (Date.now() < deadline) {
      await pause(200);
      const d = await detail(id);
      for (const decision of d.summary.attachment.decisions) {
        const provider = d.summary.task.provider;
        const option = provider === "deepseek" ? "allow-once" : "approve_once";
        const tool = provider === "deepseek"
          ? `mcp__rho__rho_host_overview_v1_${createHash("sha256").update("rho\0rho.host.overview.v1").digest("hex").slice(0, 12)}`
          : "mcp__rho__rho_host_overview_v1";
        assert.ok(overview && options.allowOverview && decision.title === tool && decision.options.some(o => o.id === option),
          `Unexpected native permission: ${decision.title}; no approval sent`);
        if (!decisions.has(decision.id)) {
          decisions.add(decision.id);
          await command({ kind: "decision", control: control(d), decision_id: decision.id, option_id: option });
        }
      }
      const { receipt } = await query({ kind: "receipt", request_id: requestId });
      if (receipt && !["prepared", "submitted"].includes(receipt.status)) {
        assert.equal(receipt.status, "succeeded", safe(receipt.error));
        return detail(id);
      }
    }
    throw new Error("Native request timed out; the original request was not replayed.");
  };
  const submit = async (d, text, extra = {}) => {
    d = (await command({ kind: "save_draft", control: control(d), version: d.draft.version,
      content: { text, assets: d.draft.content.assets, context: [], ...extra } })).detail;
    const requestId = randomUUID(), request = { kind: "send", control: control(d), draft_version: d.draft.version };
    await command(request, requestId);
    await command(request, requestId); // Simulated lost ACK: exact identity, no second native turn.
    return { id: d.summary.task.task_id, requestId };
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

      const tasks = [];
      for (const word of ["alpha", "beta"]) {
        const d = (await command({ kind: "create", provider, model: selected.id, effort })).detail;
        assert.equal(d.summary.task.native_session_id, null);
        clients.add(d.summary.task.task_id);
        tasks.push({ detail: d, word });
      }
      const submitted = await Promise.all(tasks.map(async t => ({ ...await submit(t.detail, `Reply with exactly ${t.word}. Do not use tools.`), word: t.word })));
      await Promise.all(submitted.map(t => settled(t.id, t.requestId)));
      const nativeIds = [];
      for (const task of submitted) {
        let d = await detail(task.id);
        nativeIds.push(d.summary.task.native_session_id);
        assert.equal(await reply(task.id, task.requestId), task.word);
        const disconnected = await command({ kind: "disconnect", control: control(d) });
        await settled(task.id, disconnected.receipt.request_id);
        d = await detail(task.id);
        const resumed = await command({ kind: "resume", control: control(d) });
        d = await settled(task.id, resumed.receipt.request_id);
        assert.equal(d.summary.task.native_session_id, nativeIds.at(-1));
        assert.equal(d.summary.attachment.state, "ready");
        report({ provider, phase: "parallel-task-and-native-resume", reply: task.word, sameNativeId: true });
      }
      assert.notEqual(nativeIds[0], nativeIds[1]);
      if (options.allowOverview) {
        const beforeOverview = await api("/api/agent-connection");
        const served = new Map(beforeOverview.sessions.map(s => [s.connection_id, s.overview_served_at_ms]));
        const task = await submit(await detail(submitted[0].id), "Use the configured rho MCP tools to read host.overview. Return only the final directory name of its project_root, as plain text. Do not use shell, edit files, configure anything, or run R.");
        await settled(task.id, task.requestId, { overview: true });
        const observed = await api("/api/agent-connection");
        const reads = observed.sessions.filter(s => s.overview_served_at_ms && s.overview_served_at_ms !== served.get(s.connection_id));
        assert.ok(reads.length > 0, "No new native MCP overview read");
        assert.equal(await reply(task.id, task.requestId), path.basename(project));
        report({ provider, phase: "resumed-native-mcp-overview", actualOverviewReads: reads.length, projectMatches: true });
      }
      // Some ACP providers publish usage_update after the terminal prompt reply.
      // Observe that late record briefly without sending another native prompt.
      let usage = [], usageDeadline = Date.now() + 2000;
      do {
        usage = (await Promise.all(submitted.map(task => events(task.id)))).flat().flatMap(event => event.usage ? [event.usage] : []);
        if (usage.length || Date.now() >= usageDeadline) break;
        await pause(100);
      } while (true);
      for (const observation of usage) {
        assert.equal(typeof observation.source, "string");
        assert.ok(["turn_total", "session_total", "context_window"].includes(observation.scope));
        for (const field of ["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_tokens", "reasoning_tokens", "total_tokens", "context_used", "context_capacity"])
          assert.ok(observation[field] === null || (Number.isSafeInteger(observation[field]) && observation[field] >= 0), `Invalid native usage ${field}`);
      }
      report({ provider, phase: "native-usage", available: usage.length > 0, observations: usage, missingCounters: "unknown" });
      for (const t of submitted) {
        const d = await detail(t.id), r = await command({ kind: "disconnect", control: control(d) });
        await settled(t.id, r.receipt.request_id); clients.delete(t.id);
      }

    }
  } catch (error) {
    failure = error;
    for (const id of clients) {
      try {
        const d = await detail(id), observed = await events(id);
        report({ phase: "native-failure-observation", provider: d.summary.task.provider, model: d.summary.task.model,
          state: d.summary.attachment.state, error: d.summary.attachment.error,
          assistantMessages: observed.filter(event => event.role === "assistant" && event.text.trim()).length,
          usage: observed.flatMap(event => event.usage ? [event.usage] : []), missingCounters: "unknown" });
      } catch { report({ phase: "native-failure-observation", available: false, missingCounters: "unknown" }); }
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(maximum);
    for (const id of clients) {
      try { const d = await detail(id); await command({ kind: "disconnect", control: control(d) }, randomUUID(), true); }
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
