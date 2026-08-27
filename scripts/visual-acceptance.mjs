#!/usr/bin/env node

// Visual acceptance lane driver. Launches the debug desktop build with the
// acceptance bridge enabled, runs the scenario modules under
// scripts/visual-acceptance/, captures per-gate screenshots and deterministic
// assertions into one evidence ledger, and records frame-by-frame visual
// verdicts written back via the `record-review` command.
//
// Usage:
//   node scripts/visual-acceptance.mjs run [--app <path>] [--output <dir>]
//       [--fixtures <dir>] [--scenarios s0,s1,s2,s3,s7,s8,s9] [--keep-app]
//   node scripts/visual-acceptance.mjs record-review --run <dir>
//       --frame <name> --verdict pass|fail [--note <text>]
//   node scripts/visual-acceptance.mjs finalize --run <dir>

import { spawn, execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { captureStartupBrowserFrames } from "./visual-acceptance/startup-browser.mjs";
import { captureVibeAgentBrowserFrames } from "./visual-acceptance/vibe-agent-browser.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scenarioDirectory = path.join(repositoryRoot, "scripts", "visual-acceptance");

export const EVIDENCE_SCHEMA = "rho_visual_acceptance_v1";
export const STARTUP_TERMINAL_MESSAGE_PREFIX = "Runtime bootstrap failed:";
export const STARTUP_LOG_MAX_BYTES = 1024 * 1024;

export const SCENARIOS = Object.freeze([
  { id: "s0", file: "s0-startup.mjs", title: "Startup, project open, first-view file tree" },
  { id: "s1", file: "s1-workbench-tour.mjs", title: "Workbench tour: Console, Environment, Data Viewer, Plots, Runs, Problems" },
  { id: "s2", file: "s2-qc-workflow.mjs", title: "Single-cell QC workflow with deterministic expectations" },
  { id: "s3", file: "s3-agent.mjs", title: "Agent Ask/Plan/Act (truthful SKIP without credentials)" },
  { id: "s7", file: "s7-git-review.mjs", title: "Reviewable Git mutations and conflict banner" },
  { id: "s8", file: "s8-persistence-boundaries.mjs", title: "Persistence, project switching, and boundary projects" },
  { id: "s9", file: "s9-vibe.mjs", title: "Vibe information flow: wide/intermediate overview, focus modes, and narrow reading" },
]);

export class AcceptanceError extends Error {}

export function acceptanceLaunchEnvironment(output, {
  parentEnvironment = process.env,
  rscript = null,
} = {}) {
  const environment = {
    ...parentEnvironment,
    RHO_ACCEPTANCE_BRIDGE: "1",
    RHO_ACCEPTANCE_OUTPUT: output,
  };
  if (rscript != null) environment.RHO_RSCRIPT = rscript;
  return environment;
}

export function parseStartupJsonl(source) {
  const records = [];
  const lines = source.split("\n");
  const hasTrailingNewline = source.endsWith("\n");
  for (const [index, rawLine] of lines.entries()) {
    if (rawLine.trim().length === 0) continue;
    try {
      records.push(JSON.parse(rawLine));
    } catch (error) {
      // The logger appends one JSON object per line. A concurrent read may see
      // only the final line half-written; earlier malformed lines are not a
      // truthful acceptance record and fail closed.
      const isIncompleteTail = index === lines.length - 1 && !hasTrailingNewline;
      if (!isIncompleteTail) throw new AcceptanceError(`startup JSONL line ${index + 1} is invalid: ${error.message}`);
    }
  }
  return records;
}

export function readStartupJsonl(file, maxBytes = STARTUP_LOG_MAX_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new AcceptanceError("startup log byte bound must be a non-negative safe integer");
  }
  const descriptor = fs.openSync(file, "r");
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new AcceptanceError("startup log is not a regular file");
    }
    const chunks = [];
    let bytesRead = 0;
    while (bytesRead <= maxBytes) {
      const remaining = maxBytes + 1 - bytesRead;
      if (remaining === 0) break;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      bytesRead += count;
    }
    if (bytesRead > maxBytes) {
      throw new AcceptanceError(`startup log exceeds the ${maxBytes}-byte acceptance bound`);
    }
    return parseStartupJsonl(Buffer.concat(chunks, bytesRead).toString("utf8"));
  } finally {
    fs.closeSync(descriptor);
  }
}

export function terminalStartupRecord(
  records,
  prefix = STARTUP_TERMINAL_MESSAGE_PREFIX,
) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const message = record?.event?.message;
    if (typeof message === "string" && message.startsWith(prefix)) {
      const token = startupRecordToken(record);
      return { record, token };
    }
  }
  return null;
}

export function startupRecordToken(record) {
  return createHash("sha256")
    .update(JSON.stringify([record?.timestamp ?? null, record?.event?.message ?? null]))
    .digest("hex");
}

export function startupRecordTokenIsPresent(records, token) {
  return records.some((record) => startupRecordToken(record) === token);
}

export function pngSha256(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    throw new AcceptanceError("stable-frame probe is not a PNG");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

export function consecutivePngHashesMatch(previousHash, currentHash) {
  return typeof previousHash === "string" && previousHash.length > 0 && previousHash === currentHash;
}

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
// before capturing frames. The confirmation is bounded and fail-closed so a
// real-app DOM action is never dispatched to a background or unknown process.
async function activateApp(pid) {
  if (process.platform !== "darwin") return;
  if (typeof pid !== "number") {
    throw new AcceptanceError("exact application PID is unavailable for foreground confirmation");
  }
  const script = [
    'tell application "System Events"',
    `set targetProcess to first process whose unix id is ${pid}`,
    "set frontmost of targetProcess to true",
    "return frontmost of targetProcess",
    "end tell",
  ].join("\n");
  await new Promise((resolve, reject) => {
    try {
      execFile("osascript", ["-e", script], { timeout: 5_000 }, (error, stdout) => {
        if (error != null) {
          reject(new AcceptanceError(
            `exact application foreground confirmation failed: ${error.message}`,
          ));
          return;
        }
        if (stdout.trim().toLowerCase() !== "true") {
          reject(new AcceptanceError(
            `exact application ${pid} did not become foreground`,
          ));
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(new AcceptanceError(
        `exact application foreground confirmation failed: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  });
}

export async function runForegroundedRealDebugOperation({ pid, activate, operation }) {
  await activate(pid);
  return operation();
}

export async function dispatchRealDebugAction({ pid, action, activate, command }) {
  return runForegroundedRealDebugOperation({
    pid,
    activate,
    operation: () => command({ command: "act", action }),
  });
}

export async function runEvidenceClassCheck({ evidenceClass, pid, activate, check }) {
  if (evidenceClass === "real_debug_app") {
    return runForegroundedRealDebugOperation({ pid, activate, operation: check });
  }
  if (evidenceClass === "browser_mock") return check();
  throw new AcceptanceError(`unsupported visual evidence class: ${evidenceClass}`);
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
    "| Scenario | Gate | Evidence | Deterministic | Capture | Visual | Screenshot |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const gate of evidence.gates) {
    lines.push(
      `| ${reportCell(gate.scenario)} | ${reportCell(gate.name)} | ${reportCell(gate.evidence_class)} | ${reportCell(gate.deterministic_status)} | ${reportCell(gate.screenshot_capture_status ?? (gate.screenshot == null ? "N/A" : "legacy"))} | ${reportCell(gate.visual_status)} | ${reportCell(gate.screenshot)} |`,
    );
    if (gate.error) lines.push(`|  | error: ${reportCell(gate.error)} |  |  |  |  |  |`);
    if (gate.visual_note) lines.push(`|  | visual note: ${reportCell(gate.visual_note)} |  |  |  |  |  |`);
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
        evidence_class: gate.evidence_class ?? "real_debug_app",
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

function runtimeAttentionGateRecord() {
  return {
    scenario: "s0",
    name: "startup-runtime-attention-real-debug",
    evidence_class: "real_debug_app",
    deterministic_status: "PASS",
    screenshot_capture_status: "PENDING",
    visual_status: "PENDING",
    visual_note: null,
    status: "PENDING",
    error: null,
    screenshot: "screenshots/s0-startup-runtime-attention.png",
    criteria: [
      "精确 debug 应用在真实 R runtime 失败时显示三阶段启动台账，失败阶段明确为 R runtime",
      "失败态只显示一个 Rho 字标，不出现 RRho、Surface、百分比或 ETA",
      "Choose Rscript 与 Retry 可辨认，技术细节退居 disclosure，1024×680 下无重叠或横向溢出",
    ],
    at: nowIso(),
    detail: {
      viewport: { width: 1024, height: 680 },
      rscript_fixture: "node executable (intentionally not R)",
      readiness: "startup.jsonl terminal record plus two equal consecutive PNG hashes",
      automation_endpoint_used: false,
    },
  };
}

async function capturePreReadyRuntimeAttention({
  appPath,
  output,
  stdoutLog,
  stderrLog,
}) {
  const record = runtimeAttentionGateRecord();
  const descriptorFile = path.join(output, "bridge.json");
  const logFile = path.join(output, "app-data", "logs", "startup.jsonl");
  const screenshotRoot = path.resolve(output, "screenshots");
  const finalFrame = path.join(screenshotRoot, "s0-startup-runtime-attention.png");
  const probeFiles = [];
  let child = null;
  let residualChild = null;
  try {
    if (process.platform !== "darwin") {
      throw new AcceptanceError("real debug-app startup screenshots are supported only on macOS");
    }
    if (process.release?.name !== "node" || !fs.statSync(process.execPath).isFile()) {
      throw new AcceptanceError("the pre-ready non-R fixture must be the current Node executable");
    }
    fs.rmSync(descriptorFile, { force: true });
    child = spawn(appPath, [], {
      env: acceptanceLaunchEnvironment(output, { rscript: process.execPath }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(stdoutLog, { end: false });
    child.stderr.pipe(stderrLog, { end: false });
    const descriptor = await waitFor("pre-ready acceptance bridge startup", () => {
      if (!fs.existsSync(descriptorFile)) return null;
      const parsed = JSON.parse(fs.readFileSync(descriptorFile, "utf8"));
      return typeof parsed.port === "number" && parsed.pid === child.pid ? parsed : null;
    }, { timeoutMs: 45_000 });
    const bridge = bridgeClient(descriptor.port);
    await waitFor("pre-ready acceptance bridge health", () => bridge.health(), { timeoutMs: 15_000 });
    await activateApp(child.pid);

    const terminal = await waitFor("runtime bootstrap terminal startup record", () => {
      if (!fs.existsSync(logFile)) return null;
      return terminalStartupRecord(readStartupJsonl(logFile));
    }, { timeoutMs: 75_000, intervalMs: 250 });
    await bridge.setWindow(1024, 680);
    await activateApp(child.pid);

    let previousHash = null;
    let stable = null;
    const deadline = Date.now() + 30_000;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt += 1;
      if (!startupRecordTokenIsPresent(readStartupJsonl(logFile), terminal.token)) {
        throw new AcceptanceError("runtime terminal startup record disappeared before screenshot capture");
      }
      const probeName = `s0-startup-runtime-attention-probe-${String(attempt).padStart(3, "0")}`;
      const shot = await bridge.screenshot(probeName);
      const probeFile = path.resolve(shot.path);
      if (probeFile !== screenshotRoot && !probeFile.startsWith(`${screenshotRoot}${path.sep}`)) {
        throw new AcceptanceError("startup screenshot probe escaped the acceptance output");
      }
      probeFiles.push(probeFile);
      const hash = pngSha256(probeFile);
      if (!startupRecordTokenIsPresent(readStartupJsonl(logFile), terminal.token)) {
        throw new AcceptanceError("runtime terminal startup record disappeared after screenshot capture");
      }
      if (consecutivePngHashesMatch(previousHash, hash)) {
        fs.renameSync(probeFile, finalFrame);
        probeFiles.pop();
        stable = {
          hash,
          attempts: attempt,
          bytes: fs.statSync(finalFrame).size,
          terminal_token: terminal.token,
          terminal_message: terminal.record.event.message,
        };
        break;
      }
      previousHash = hash;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    if (stable == null) {
      throw new AcceptanceError("runtime-attention frontend did not produce two consecutive equal PNG hashes");
    }
    record.screenshot_bytes = stable.bytes;
    record.screenshot_capture_status = "PASS";
    record.detail = { ...record.detail, ...stable };
  } catch (error) {
    record.deterministic_status = "FAIL";
    record.screenshot_capture_status = "FAIL";
    record.visual_status = "N/A";
    record.status = "FAIL";
    record.error = error instanceof Error ? error.message : String(error);
    record.screenshot = null;
  } finally {
    for (const probeFile of probeFiles) fs.rmSync(probeFile, { force: true });
    const terminated = await terminateChild(child);
    if (!terminated) {
      residualChild = child;
      record.deterministic_status = "FAIL";
      record.status = "FAIL";
      record.error = record.error == null
        ? "non-R fixture application did not terminate"
        : `${record.error}; non-R fixture application did not terminate`;
    }
    fs.rmSync(descriptorFile, { force: true });
  }
  return { record, residualChild };
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
  const selected = options.scenarios ?? SCENARIOS.map((scenario) => scenario.id);
  const lockOwner = `${(options.scenarios ?? []).join("+") || "all"}:${process.pid}`;
  const state = { child: null, bridge: null };
  let stdoutLog = null;
  let stderrLog = null;
  let lockHeld = false;
  let preserveChildAndLock = false;
  let residualFixtureBlocksKeepApp = false;
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

    if (selected.includes("s0")) {
      const { record: runtimeAttention, residualChild } = await capturePreReadyRuntimeAttention({
        appPath,
        output,
        stdoutLog,
        stderrLog,
      });
      evidence.gates.push(runtimeAttention);
      refreshLedger(output, evidence);
      if (residualChild != null) {
        // Keep the exact residual PID attached to the real-window lock. The
        // outer finalizer retries termination and either releases the lock
        // after confirmed exit or transfers ownership to this PID. No normal
        // launch may share its app-data, bridge descriptor, or window.
        state.child = residualChild;
        residualFixtureBlocksKeepApp = true;
        throw new AcceptanceError(
          `pre-ready fixture application ${residualChild.pid} survived termination; ready-path launch blocked`,
        );
      }
    }

    const launch = async (windowSize = null) => {
      const descriptorFile = path.join(output, "bridge.json");
      fs.rmSync(descriptorFile, { force: true });
      const child = spawn(appPath, [], {
        env: acceptanceLaunchEnvironment(output),
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.pipe(stdoutLog, { end: false });
      child.stderr.pipe(stderrLog, { end: false });
      state.child = child;
      const bridgeDescriptor = await waitFor("acceptance bridge startup", () => {
        if (!fs.existsSync(descriptorFile)) return null;
        const parsed = JSON.parse(fs.readFileSync(descriptorFile, "utf8"));
        return typeof parsed.port === "number" && parsed.pid === child.pid ? parsed : null;
      }, { timeoutMs: 45_000 });
      const bridge = bridgeClient(bridgeDescriptor.port);
      await waitFor("acceptance bridge health", () => bridge.health(), { timeoutMs: 15_000 });
      if (windowSize != null) await bridge.setWindow(windowSize.width, windowSize.height);
      // The driver awaits each command in sequence, and an unanswered eval can
      // occupy that sequence for its full 300s timeout. An eval emitted before
      // the frontend listener attaches is lost, even though the bridge itself
      // can accept other bounded connections. So: activate the app first (a
      // WKWebView born occluded is suspended and never loads), give the
      // frontend a grace period to install the listener, and only then probe.
      await activateApp(child.pid);
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      await activateApp(child.pid);
      await waitFor("frontend automation surface", async () => {
        await activateApp(child.pid);
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

    await launch(selected.includes("s0") ? { width: 1440, height: 900 } : null);

    const context = {
      get bridge() { return state.bridge; },
      command: (request) => state.bridge.command(request),
      // Foregrounding is an exact-app transport precondition only. It does not
      // retry or add product settling to any action, including open_project.
      act: (action) => dispatchRealDebugAction({
        pid: state.child?.pid,
        action,
        activate: activateApp,
        command: (request) => state.bridge.command(request),
      }),
      ready: () => state.bridge.command({ command: "ready" }),
      snapshot: () => state.bridge.command({ command: "snapshot" }),
      query: (selector, options = {}) => state.bridge.command({ command: "query", selector, ...options }),
      setWindow: (width, height) => state.bridge.setWindow(width, height),
      restart: async (windowSize = null) => {
        const terminated = await terminateChild(state.child);
        if (!terminated) throw new AcceptanceError("application did not stop for restart");
        return launch(windowSize);
      },
      captureStartupBrowserFrames: async () => captureStartupBrowserFrames({
        output,
        onRecord: (record) => {
          const problem = reviewableFrameProblem(output, record);
          if (problem != null) {
            record.screenshot_capture_status = "FAIL";
            record.visual_status = "FAIL";
            record.status = "FAIL";
            appendGateError(record, `screenshot evidence invalid: ${problem}`);
          }
          evidence.gates.push(record);
          refreshLedger(output, evidence);
        },
      }),
      captureVibeAgentBrowserFrames: async () => captureVibeAgentBrowserFrames({
        output,
        onRecord: (record) => {
          const problem = reviewableFrameProblem(output, record);
          if (problem != null) {
            record.screenshot_capture_status = "FAIL";
            record.visual_status = "FAIL";
            record.status = "FAIL";
            appendGateError(record, `screenshot evidence invalid: ${problem}`);
          }
          evidence.gates.push(record);
          refreshLedger(output, evidence);
        },
      }),
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
        { screenshot = null, criteria = [], fatal = true, evidenceClass = "real_debug_app" } = {},
      ) => {
        if (screenshot != null && evidenceClass !== "real_debug_app") {
          throw new AcceptanceError(
            "browser/mock screenshots must use their isolated collector",
          );
        }
        const record = {
          scenario,
          name,
          evidence_class: evidenceClass,
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
          const detail = await runEvidenceClassCheck({
            evidenceClass,
            pid: state.child?.pid,
            activate: activateApp,
            check,
          });
          if (detail != null) record.detail = detail;
        } catch (error) {
          record.deterministic_status = "FAIL";
          record.status = "FAIL";
          record.error = error.message;
        }
        if (screenshot != null) {
          try {
            await activateApp(state.child?.pid);
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
          evidence_class: "real_debug_app",
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
        options.keepApp && !residualFixtureBlocksKeepApp && state.child != null &&
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
