#!/usr/bin/env node

// Visual acceptance lane driver. Launches the debug desktop build with the
// acceptance bridge enabled, runs the scenario modules under
// scripts/visual-acceptance/, captures per-gate screenshots and deterministic
// assertions into one evidence ledger, and records frame-by-frame visual
// verdicts written back via the `record-review` command.
//
// Usage:
//   node scripts/visual-acceptance.mjs run [--app <path>] [--output <dir>]
//       [--fixtures <dir>] [--scenarios s0,s1,s2,s7,s8] [--keep-app]
//   node scripts/visual-acceptance.mjs record-review --run <dir>
//       --frame <name> --verdict pass|fail [--note <text>]
//   node scripts/visual-acceptance.mjs finalize --run <dir>

import { spawn, execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scenarioDirectory = path.join(repositoryRoot, "scripts", "visual-acceptance");

export const EVIDENCE_SCHEMA = "rho_visual_acceptance_v1";

export const SCENARIOS = Object.freeze([
  { id: "s0", file: "s0-startup.mjs", title: "Startup, project open, first-view file tree" },
  { id: "s1", file: "s1-workbench-tour.mjs", title: "Workbench tour: Console, Environment, Data Viewer, Plots, Runs, Problems" },
  { id: "s2", file: "s2-qc-workflow.mjs", title: "Single-cell QC workflow with deterministic expectations" },
  { id: "s3", file: "s3-agent.mjs", title: "Agent Ask/Plan/Act (truthful SKIP without credentials)" },
  { id: "s7", file: "s7-git-review.mjs", title: "Reviewable Git mutations and conflict banner" },
  { id: "s8", file: "s8-persistence-boundaries.mjs", title: "Persistence, project switching, and boundary projects" },
]);

export class AcceptanceError extends Error {}

function nowIso() {
  return new Date().toISOString();
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function bridgeClient(port) {
  const base = `http://127.0.0.1:${port}`;
  async function post(route, payload, timeoutMs = 320_000) {
    const response = await fetch(`${base}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => null);
    if (body == null) throw new AcceptanceError(`bridge ${route} returned no JSON (HTTP ${response.status})`);
    return body;
  }
  return {
    health: async () => {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) });
      return response.ok;
    },
    // The frontend cannot eval arbitrary strings (CSP script-src 'self'), so
    // `request` is a JSON AutomationRequest interpreted by the fixed
    // automation surface; the bridge forwards it opaquely as "js".
    command: async (request, timeoutMs) => {
      const result = await post("/eval", { js: JSON.stringify(request) }, timeoutMs);
      if (!result.ok) throw new AcceptanceError(`automation request failed: ${result.error ?? "unknown"}`);
      return result.value;
    },
    screenshot: async (name) => {
      const result = await post("/screenshot", { name });
      if (!result.ok) throw new AcceptanceError(`screenshot failed: ${result.error ?? "unknown"}`);
      return result;
    },
    setWindow: async (width, height) => {
      const result = await post("/window", { width, height });
      if (!result.ok) throw new AcceptanceError(`window resize failed: ${result.error ?? "unknown"}`);
      return result;
    },
  };
}

async function waitFor(label, probe, { timeoutMs = 60_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new AcceptanceError(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

// On macOS a WKWebView whose window is born occluded or on a hidden Space is
// suspended: the page load stalls and `rho://acceptance-eval` events are
// never handled. Bringing the application to the foreground resumes the
// webview, so the lane activates the app before probing the frontend and
// before capturing frames. Best-effort; failures are ignored.
function activateApp(pid) {
  if (process.platform !== "darwin" || typeof pid !== "number") return;
  const script = `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`;
  execFile("osascript", ["-e", script], () => undefined);
}

function createEvidence(output, appPath) {
  return {
    schema: EVIDENCE_SCHEMA,
    status: "FAIL",
    started_at: nowIso(),
    finished_at: null,
    output,
    app: appPath,
    platform: `${process.platform}-${process.arch}`,
    scenarios: [],
    gates: [],
    error: null,
  };
}

export function summarizeEvidence(evidence) {
  const gates = evidence.gates;
  const failed = gates.filter((gate) => gate.status === "FAIL");
  const skipped = gates.filter((gate) => gate.status === "SKIP");
  const deterministicFailed = failed.filter((gate) => gate.deterministic_status === "FAIL");
  const visualPending = gates.filter((gate) => gate.visual_status === "PENDING");
  const visualFailed = gates.filter((gate) => gate.visual_status === "FAIL");
  return {
    gates: gates.length,
    passed: gates.filter((gate) => gate.status === "PASS").length,
    failed: failed.length,
    skipped: skipped.length,
    deterministic_failed: deterministicFailed.length,
    visual_pending: visualPending.length,
    visual_failed: visualFailed.length,
  };
}

export function reconcileScenarioStatuses(evidence) {
  for (const scenario of evidence.scenarios) {
    const gates = evidence.gates.filter((gate) => gate.scenario === scenario.id);
    if (scenario.error != null) {
      scenario.status = "FAIL";
    } else if (gates.length === 0) {
      scenario.status = "FAIL";
      scenario.error = "Scenario produced no gate evidence.";
    } else if (gates.some((gate) =>
      gate.status === "FAIL" || gate.deterministic_status === "FAIL" || gate.visual_status === "FAIL")) {
      scenario.status = "FAIL";
    } else if (gates.some((gate) => gate.status === "PENDING" || gate.visual_status === "PENDING")) {
      scenario.status = "PENDING";
    } else if (gates.some((gate) => gate.status === "SKIP" || gate.deterministic_status === "SKIP")) {
      scenario.status = "SKIP";
    } else {
      scenario.status = "PASS";
    }
  }
  return evidence;
}

export function scenarioResults(evidence) {
  return evidence.scenarios.map((scenario) => ({
    id: scenario.id,
    status: scenario.status,
    duration_ms: scenario.duration_ms,
    error: scenario.error,
  }));
}

function reportCell(value) {
  return String(value ?? "-")
    .replaceAll("|", "\\|")
    .replaceAll(/\r?\n/g, "<br>");
}

export function renderReport(evidence) {
  const summary = summarizeEvidence(evidence);
  const lines = [
    "# Rho Visual Acceptance Report",
    "",
    `- status: ${evidence.status}`,
    `- app: ${evidence.app}`,
    `- platform: ${evidence.platform}`,
    `- started: ${evidence.started_at}`,
    `- finished: ${evidence.finished_at ?? "in progress"}`,
    `- scenarios: ${evidence.scenarios.length}`,
    `- gates: ${summary.gates} (${summary.passed} pass, ${summary.failed} fail, ${summary.skipped} skip)`,
    `- deterministic failures: ${summary.deterministic_failed}; visual pending: ${summary.visual_pending}; visual failures: ${summary.visual_failed}`,
    "",
    "## Scenarios",
    "",
    "| Scenario | Status | Duration (ms) | Error |",
    "| --- | --- | ---: | --- |",
    ...evidence.scenarios.map((scenario) =>
      `| ${reportCell(scenario.id)} | ${reportCell(scenario.status)} | ${reportCell(scenario.duration_ms)} | ${reportCell(scenario.error)} |`
    ),
    "",
    "## Gates",
    "",
    "| Scenario | Gate | Deterministic | Capture | Visual | Screenshot |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const gate of evidence.gates) {
    lines.push(
      `| ${reportCell(gate.scenario)} | ${reportCell(gate.name)} | ${reportCell(gate.deterministic_status)} | ${reportCell(gate.screenshot_capture_status ?? (gate.screenshot == null ? "N/A" : "legacy"))} | ${reportCell(gate.visual_status)} | ${reportCell(gate.screenshot)} |`,
    );
    if (gate.error) lines.push(`|  | error: ${reportCell(gate.error)} |  |  |  |  |`);
    if (gate.visual_note) lines.push(`|  | visual note: ${reportCell(gate.visual_note)} |  |  |  |  |`);
  }
  return `${lines.join("\n")}\n`;
}

function refreshLedger(runDirectory, evidence) {
  writeJson(path.join(runDirectory, "evidence.json"), evidence);
  const manifest = {
    schema: "rho_visual_acceptance_visual_review_v1",
    frames: evidence.gates
      .filter((gate) => gate.screenshot != null)
      .map((gate) => ({
        frame: gate.screenshot,
        scenario: gate.scenario,
        gate: gate.name,
        criteria: gate.criteria,
        screenshot_capture_status: gate.screenshot_capture_status
          ?? (gate.screenshot_bytes > 0 ? "PASS" : "UNKNOWN"),
        screenshot_bytes: gate.screenshot_bytes ?? null,
        visual_status: gate.visual_status,
        visual_note: gate.visual_note,
      })),
  };
  writeJson(path.join(runDirectory, "visual-review-manifest.json"), manifest);
  fs.writeFileSync(path.join(runDirectory, "report.md"), renderReport(evidence));
}

function appendGateError(gate, message) {
  if (typeof gate.error !== "string" || gate.error.length === 0) {
    gate.error = message;
  } else if (!gate.error.includes(message)) {
    gate.error = `${gate.error}; ${message}`;
  }
}

function resolvedFramePath(runDirectory, screenshot) {
  if (typeof screenshot !== "string" || screenshot.length === 0) {
    return { error: "frame has no screenshot path" };
  }
  const screenshotRoot = path.resolve(runDirectory, "screenshots");
  const framePath = path.resolve(runDirectory, screenshot);
  if (framePath !== screenshotRoot && !framePath.startsWith(`${screenshotRoot}${path.sep}`)) {
    return { error: `screenshot path escapes the run directory: ${screenshot}` };
  }
  return { framePath };
}

export function reviewableFrameProblem(runDirectory, gate) {
  const captureStatus = gate.screenshot_capture_status
    ?? (Number.isFinite(gate.screenshot_bytes) && gate.screenshot_bytes > 0 ? "PASS" : "UNKNOWN");
  if (captureStatus !== "PASS") return `screenshot capture status is ${captureStatus}`;
  if (!Number.isFinite(gate.screenshot_bytes) || gate.screenshot_bytes <= 0) {
    return "screenshot byte count is missing or non-positive";
  }
  if (!Array.isArray(gate.criteria) || !gate.criteria.some((criterion) =>
    typeof criterion === "string" && criterion.trim().length > 0)) {
    return "visual review criteria are missing";
  }
  const resolved = resolvedFramePath(runDirectory, gate.screenshot);
  if (resolved.error != null) return resolved.error;
  let stat;
  try {
    stat = fs.lstatSync(resolved.framePath);
  } catch (error) {
    return `screenshot artifact is unreadable: ${error.message}`;
  }
  if (!stat.isFile() || stat.size <= 0) return "screenshot artifact is not a non-empty file";
  if (stat.size !== gate.screenshot_bytes) {
    return `screenshot byte count mismatch (evidence=${gate.screenshot_bytes}, file=${stat.size})`;
  }
  const pngSignature = Buffer.alloc(8);
  let descriptor;
  try {
    descriptor = fs.openSync(resolved.framePath, "r");
    if (fs.readSync(descriptor, pngSignature, 0, pngSignature.length, 0) !== pngSignature.length ||
        !pngSignature.equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
      return "screenshot artifact is not a PNG";
    }
  } catch (error) {
    return `screenshot artifact cannot be inspected: ${error.message}`;
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
  return null;
}

export function enforceFrameIntegrity(runDirectory, evidence) {
  for (const gate of evidence.gates) {
    if (gate.screenshot == null) continue;
    const problem = reviewableFrameProblem(runDirectory, gate);
    if (problem != null) {
      gate.screenshot_capture_status = "FAIL";
      gate.visual_status = "FAIL";
      gate.status = "FAIL";
      appendGateError(gate, `screenshot evidence invalid: ${problem}`);
      gate.visual_note = `Screenshot evidence invalid: ${problem}`;
    } else if (!["PASS", "FAIL", "PENDING"].includes(gate.visual_status)) {
      // A captured frame without a recognized verdict remains pending rather
      // than disappearing from the visual review tally.
      gate.visual_status = "PENDING";
      gate.status = gate.deterministic_status === "FAIL" ? "FAIL" : "PENDING";
    }
  }
  return evidence;
}

export function finalizeStatus(evidence, runDirectory = null) {
  if (runDirectory != null) enforceFrameIntegrity(runDirectory, evidence);
  reconcileScenarioStatuses(evidence);
  const summary = summarizeEvidence(evidence);
  const scenarioBlocked = evidence.scenarios.some(
    (scenario) => scenario.status === "FAIL" || scenario.status === "PENDING",
  );
  evidence.status = evidence.error == null && evidence.scenarios.length > 0 &&
      !scenarioBlocked && summary.deterministic_failed === 0 &&
      summary.failed === 0 && summary.visual_failed === 0 && summary.visual_pending === 0
    ? "PASS"
    : "FAIL";
  return evidence;
}

// The real application window is an exclusive resource: several acceptance
// lanes may develop scenarios in parallel, but only one harness process may
// drive a live app at a time. The lock is a directory (atomic mkdir) with an
// owner record. A dead PID is reclaimed immediately; an ownerless or corrupt
// record is reclaimed only after a grace that protects the mkdir/write gap.
const APP_LOCK_DIR = path.join(repositoryRoot, "target", "visual-acceptance-real-window.lock");
const APP_LOCK_ORPHAN_GRACE_MS = 30_000;

function lockRecord(lockDirectory) {
  const ownerFile = path.join(lockDirectory, "owner.json");
  try {
    const value = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
    return Number.isInteger(value.pid) && value.pid > 0
      ? { kind: "valid", value }
      : { kind: "corrupt" };
  } catch {
    return { kind: "corrupt" };
  }
}

function processIsDefinitelyGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM proves that the process exists but is not signalable. Only ESRCH
    // is sufficient evidence to reclaim a valid owner's lock immediately.
    return error.code === "ESRCH";
  }
}

function orphanLockAgeMs(lockDirectory) {
  const mtimes = [];
  for (const candidate of [lockDirectory, path.join(lockDirectory, "owner.json")]) {
    try { mtimes.push(fs.statSync(candidate).mtimeMs); } catch { /* absent */ }
  }
  return mtimes.length === 0 ? 0 : Math.max(0, Date.now() - Math.max(...mtimes));
}

function reclaimLock(lockDirectory) {
  const quarantine = `${lockDirectory}.stale-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(lockDirectory, quarantine);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  fs.rmSync(quarantine, { recursive: true, force: true });
  return true;
}

export async function acquireAppLock(owner, {
  timeoutMs = 45 * 60_000,
  lockDirectory = APP_LOCK_DIR,
  orphanGraceMs = APP_LOCK_ORPHAN_GRACE_MS,
  pollIntervalMs = 2_000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lockDirectory);
      try {
        writeJson(path.join(lockDirectory, "owner.json"), { owner, pid: process.pid, at: nowIso() });
      } catch (error) {
        fs.rmSync(lockDirectory, { recursive: true, force: true });
        throw error;
      }
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const record = lockRecord(lockDirectory);
      const reclaimable = record.kind === "valid"
        ? processIsDefinitelyGone(record.value.pid)
        : orphanLockAgeMs(lockDirectory) >= orphanGraceMs;
      if (reclaimable) {
        reclaimLock(lockDirectory);
        continue;
      }
      if (Date.now() >= deadline) throw new AcceptanceError("real-window app lock wait timed out");
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

export function releaseAppLock(lockDirectory = APP_LOCK_DIR) {
  fs.rmSync(lockDirectory, { recursive: true, force: true });
}

function transferAppLock(owner, pid, lockDirectory = APP_LOCK_DIR) {
  writeJson(path.join(lockDirectory, "owner.json"), { owner, pid, at: nowIso() });
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function terminateChild(child) {
  if (child == null) return true;
  let exited = child.exitCode != null || child.signalCode != null;
  if (!exited) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    exited = await waitForChildExit(child, 5_000);
  }
  if (!exited) {
    // A suspended webview can ignore SIGTERM; make the window resource
    // truthful before releasing the cross-lane lock.
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    exited = await waitForChildExit(child, 5_000);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  return exited;
}

async function runLane(options) {
  const output = path.resolve(options.output
    ?? path.join(repositoryRoot, "target", "visual-acceptance", nowIso().replaceAll(":", "-")));
  const appPath = path.resolve(options.app);
  if (!fs.existsSync(appPath)) throw new AcceptanceError(`application binary not found: ${appPath}`);
  if (fs.existsSync(output)) {
    throw new AcceptanceError(`output directory already exists; acceptance evidence is immutable: ${output}`);
  }
  fs.mkdirSync(output, { recursive: true });

  const evidence = createEvidence(output, appPath);
  const lockOwner = `${(options.scenarios ?? []).join("+") || "all"}:${process.pid}`;
  const state = { child: null, bridge: null };
  let stdoutLog = null;
  let stderrLog = null;
  let lockHeld = false;
  let preserveChildAndLock = false;
  const fixturesRoot = path.resolve(options.fixtures ?? path.join(output, "fixtures"));

  try {
    await acquireAppLock(lockOwner);
    lockHeld = true;
    execFileSync(process.execPath, [
      path.join(repositoryRoot, "test", "acceptance-project", "tools", "prepare-fixtures.mjs"),
      "--output",
      fixturesRoot,
    ], { stdio: ["ignore", "pipe", "inherit"] });

    stdoutLog = fs.createWriteStream(path.join(output, "app-stdout.log"));
    stderrLog = fs.createWriteStream(path.join(output, "app-stderr.log"));

    const launch = async () => {
      const descriptorFile = path.join(output, "bridge.json");
      fs.rmSync(descriptorFile, { force: true });
      const child = spawn(appPath, [], {
        env: {
          ...process.env,
          RHO_ACCEPTANCE_BRIDGE: "1",
          RHO_ACCEPTANCE_OUTPUT: output,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.pipe(stdoutLog);
      child.stderr.pipe(stderrLog);
      state.child = child;
      const bridgeDescriptor = await waitFor("acceptance bridge startup", () => {
        if (!fs.existsSync(descriptorFile)) return null;
        const parsed = JSON.parse(fs.readFileSync(descriptorFile, "utf8"));
        return typeof parsed.port === "number" && parsed.pid === child.pid ? parsed : null;
      }, { timeoutMs: 45_000 });
      const bridge = bridgeClient(bridgeDescriptor.port);
      await waitFor("acceptance bridge health", () => bridge.health(), { timeoutMs: 15_000 });
      // The bridge serves connections serially and holds one unanswered eval
      // for its full 300s timeout; an eval emitted before the frontend
      // listener attaches is lost and strands every later request behind it.
      // So: activate the app first (a WKWebView born occluded is suspended and
      // never loads), give the frontend a grace period to install the
      // listener, and only then probe — patiently, because aborting a probe
      // client-side does not free the stranded server-side eval.
      activateApp(child.pid);
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      activateApp(child.pid);
      await waitFor("frontend automation surface", async () => {
        activateApp(child.pid);
        try {
          const value = await bridge.command({ command: "ready" });
          return value != null && typeof value === "object" ? true : null;
        } catch {
          return null;
        }
      }, { timeoutMs: 400_000, intervalMs: 2_000 });
      state.bridge = bridge;
      return bridge;
    };

    await launch();

    const context = {
      get bridge() { return state.bridge; },
      command: (request) => state.bridge.command(request),
      act: (action) => state.bridge.command({ command: "act", action }),
      ready: () => state.bridge.command({ command: "ready" }),
      snapshot: () => state.bridge.command({ command: "snapshot" }),
      query: (selector, options = {}) => state.bridge.command({ command: "query", selector, ...options }),
      setWindow: (width, height) => state.bridge.setWindow(width, height),
      restart: async () => {
        const terminated = await terminateChild(state.child);
        if (!terminated) throw new AcceptanceError("application did not stop for restart");
        return launch();
      },
      fixtures: {
        root: fixturesRoot,
        workingProject: path.join(fixturesRoot, "working-project"),
        conflictProject: path.join(fixturesRoot, "conflict-project"),
        unicodeProject: path.join(fixturesRoot, "路径 含 空格", "acceptance-project"),
        largeProject: path.join(fixturesRoot, "large-project-2100"),
        oversizedProject: path.join(fixturesRoot, "oversized-file-project"),
      },
      output,
      gate: async (
        scenario,
        name,
        check,
        { screenshot = null, criteria = [], fatal = true } = {},
      ) => {
        const record = {
          scenario,
          name,
          deterministic_status: "PASS",
          screenshot_capture_status: screenshot == null ? "N/A" : "PENDING",
          visual_status: screenshot == null ? "N/A" : "PENDING",
          visual_note: null,
          status: "PASS",
          error: null,
          screenshot: screenshot == null ? null : `screenshots/${screenshot}.png`,
          criteria,
          at: nowIso(),
        };
        try {
          const detail = await check();
          if (detail != null) record.detail = detail;
        } catch (error) {
          record.deterministic_status = "FAIL";
          record.status = "FAIL";
          record.error = error.message;
        }
        if (screenshot != null) {
          try {
            activateApp(state.child?.pid);
            const shot = await state.bridge.screenshot(screenshot);
            record.screenshot_bytes = shot.bytes;
            record.screenshot_capture_status = "PASS";
            const problem = reviewableFrameProblem(output, record);
            if (problem != null) throw new AcceptanceError(problem);
          } catch (error) {
            record.status = "FAIL";
            record.screenshot_capture_status = "FAIL";
            appendGateError(record, `screenshot: ${error.message}`);
            record.visual_status = "FAIL";
            record.visual_note = `Screenshot capture failed: ${error.message}`;
          }
        }
        if (record.visual_status === "PENDING") record.status = record.deterministic_status === "FAIL" ? "FAIL" : "PENDING";
        evidence.gates.push(record);
        refreshLedger(output, evidence);
        if (record.deterministic_status === "FAIL" && fatal) {
          throw new AcceptanceError(`${scenario}/${name}: ${record.error}`);
        }
        return record;
      },
      skipGate: (scenario, name, reason) => {
        evidence.gates.push({
          scenario, name,
          deterministic_status: "SKIP",
          screenshot_capture_status: "N/A",
          visual_status: "N/A",
          visual_note: null,
          status: "SKIP",
          error: null,
          screenshot: null,
          criteria: [],
          detail: { skip_reason: reason },
          at: nowIso(),
        });
        refreshLedger(output, evidence);
      },
    };

    const selected = options.scenarios ?? SCENARIOS.map((scenario) => scenario.id);
    for (const scenarioId of selected) {
      const descriptor = SCENARIOS.find((scenario) => scenario.id === scenarioId);
      if (descriptor == null) throw new AcceptanceError(`unknown scenario: ${scenarioId}`);
      const module = await import(path.join(scenarioDirectory, descriptor.file));
      const started = Date.now();
      evidence.scenarios.push({ id: scenarioId, title: descriptor.title, status: "PASS", duration_ms: 0, error: null });
      const scenarioRecord = evidence.scenarios[evidence.scenarios.length - 1];
      try {
        await module.default(context);
      } catch (error) {
        scenarioRecord.status = "FAIL";
        scenarioRecord.error = error.message;
        if (evidence.error == null) evidence.error = error.stack ?? error.message;
      } finally {
        scenarioRecord.duration_ms = Date.now() - started;
        refreshLedger(output, evidence);
      }
    }
  } catch (error) {
    if (evidence.error == null) evidence.error = error.stack ?? error.message;
  } finally {
    try {
      evidence.finished_at = nowIso();
      finalizeStatus(evidence, output);
      refreshLedger(output, evidence);
      if (
        options.keepApp && state.child != null &&
        state.child.exitCode == null && state.child.signalCode == null
      ) {
        preserveChildAndLock = true;
        transferAppLock(`kept-app:${state.child.pid}`, state.child.pid);
      }
    } finally {
      if (!preserveChildAndLock) {
        const terminated = await terminateChild(state.child);
        stdoutLog?.destroy();
        stderrLog?.destroy();
        if (lockHeld) {
          if (terminated || state.child == null) releaseAppLock();
          else transferAppLock(`termination-pending:${state.child.pid}`, state.child.pid);
        }
      }
    }
  }
  return evidence;
}

function parseOptions(argv) {
  const command = argv[0];
  const options = {
    command,
    app: path.join(repositoryRoot, "target", "debug", "rho-desktop"),
    output: null,
    fixtures: null,
    scenarios: null,
    keepApp: false,
    run: null,
    frame: null,
    verdict: null,
    note: null,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next == null || next.startsWith("--")) throw new AcceptanceError(`missing value for ${argument}`);
      index += 1;
      return next;
    };
    if (argument === "--app") options.app = value();
    else if (argument === "--output") options.output = value();
    else if (argument === "--fixtures") options.fixtures = value();
    else if (argument === "--scenarios") options.scenarios = value().split(",").map((item) => item.trim());
    else if (argument === "--keep-app") options.keepApp = true;
    else if (argument === "--run") options.run = value();
    else if (argument === "--frame") options.frame = value();
    else if (argument === "--verdict") options.verdict = value();
    else if (argument === "--note") options.note = value();
    else throw new AcceptanceError(`unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.command === "run") {
    const evidence = await runLane(options);
    const summary = summarizeEvidence(evidence);
    process.stdout.write(`${JSON.stringify({
      status: evidence.status,
      output: evidence.output,
      scenarios: scenarioResults(evidence),
      ...summary,
    }, null, 2)}\n`);
    process.exitCode = evidence.status === "PASS" ? 0 : 1;
    return;
  }
  if (options.command === "record-review") {
    if (options.run == null || options.frame == null) throw new AcceptanceError("record-review requires --run and --frame");
    if (!["pass", "fail"].includes(options.verdict ?? "")) throw new AcceptanceError("--verdict must be pass or fail");
    const evidenceFile = path.join(options.run, "evidence.json");
    const evidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
    const matchingGates = evidence.gates.filter(
      (candidate) => candidate.screenshot === `screenshots/${options.frame}.png`,
    );
    if (matchingGates.length === 0) throw new AcceptanceError(`no gate captured frame ${options.frame}`);
    if (matchingGates.length > 1) throw new AcceptanceError(`frame ${options.frame} is ambiguous across gates`);
    const [gate] = matchingGates;
    const reviewProblem = reviewableFrameProblem(options.run, gate);
    if (reviewProblem != null) {
      throw new AcceptanceError(`frame ${options.frame} is not reviewable: ${reviewProblem}`);
    }
    gate.visual_status = options.verdict.toUpperCase();
    gate.visual_note = options.note;
    gate.status = gate.deterministic_status === "FAIL" || gate.visual_status === "FAIL" ? "FAIL" : "PASS";
    finalizeStatus(evidence, options.run);
    refreshLedger(options.run, evidence);
    process.stdout.write(`${JSON.stringify({
      frame: options.frame,
      visual_status: gate.visual_status,
      run_status: evidence.status,
      scenarios: scenarioResults(evidence),
    }, null, 2)}\n`);
    return;
  }
  if (options.command === "finalize") {
    if (options.run == null) throw new AcceptanceError("finalize requires --run");
    const runDirectory = path.resolve(options.run);
    const evidence = JSON.parse(fs.readFileSync(path.join(runDirectory, "evidence.json"), "utf8"));
    finalizeStatus(evidence, runDirectory);
    refreshLedger(runDirectory, evidence);
    process.stdout.write(`${JSON.stringify({
      status: evidence.status,
      scenarios: scenarioResults(evidence),
      ...summarizeEvidence(evidence),
    }, null, 2)}\n`);
    return;
  }
  throw new AcceptanceError("usage: visual-acceptance.mjs run|record-review|finalize ...");
}

const invokedPath = process.argv[1] == null ? null : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`visual-acceptance: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
