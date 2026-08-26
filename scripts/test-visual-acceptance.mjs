#!/usr/bin/env node

// Self-test for the visual acceptance lane. This test never launches the
// application; it covers the harness evidence model, the scenario registry,
// fixture generation equivalence, and the bridge fail-closed contract as
// static source assertions.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVIDENCE_SCHEMA,
  SCENARIOS,
  acquireAppLock,
  finalizeStatus,
  reconcileScenarioStatuses,
  releaseAppLock,
  renderReport,
  scenarioResults,
  summarizeEvidence,
} from "./visual-acceptance.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const driverFile = path.join(repositoryRoot, "scripts", "visual-acceptance.mjs");

function evidenceRecord(runDirectory, { scenarios = [], gates = [], error = null } = {}) {
  return {
    schema: EVIDENCE_SCHEMA,
    status: "FAIL",
    started_at: "2026-08-26T00:00:00.000Z",
    finished_at: null,
    output: runDirectory,
    app: "/tmp/rho-desktop",
    platform: "test",
    scenarios,
    gates,
    error,
  };
}

function writeEvidence(runDirectory, evidence) {
  fs.mkdirSync(path.join(runDirectory, "screenshots"), { recursive: true });
  fs.writeFileSync(path.join(runDirectory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
}

function reviewFrame(runDirectory, frame, verdict = "pass") {
  return JSON.parse(execFileSync(process.execPath, [
    driverFile,
    "record-review",
    "--run",
    runDirectory,
    "--frame",
    frame,
    "--verdict",
    verdict,
    "--note",
    "self-test review",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

// scenario registry is complete and every module exists
{
  const ids = SCENARIOS.map((scenario) => scenario.id);
  assert.deepEqual(ids, ["s0", "s1", "s2", "s3", "s7", "s8"]);
  assert.equal(new Set(ids).size, ids.length, "scenario ids must be unique");
  for (const scenario of SCENARIOS) {
    const file = path.join(repositoryRoot, "scripts", "visual-acceptance", scenario.file);
    assert.ok(fs.existsSync(file), `scenario module is missing: ${scenario.file}`);
    assert.ok(scenario.title.length > 0, `scenario ${scenario.id} needs a title`);
  }
}

// non-fatal gates still make their owning scenario fail after aggregation
{
  const evidence = {
    schema: EVIDENCE_SCHEMA,
    status: "FAIL",
    started_at: "",
    finished_at: null,
    output: "/tmp/run",
    app: "/tmp/rho-desktop",
    platform: "test",
    scenarios: [{ id: "s8", title: "boundaries", status: "PASS", duration_ms: 1, error: null }],
    gates: [
      { scenario: "s8", name: "isolation", deterministic_status: "FAIL", visual_status: "N/A", status: "FAIL", screenshot: null, criteria: [] },
      { scenario: "s8", name: "next-independent-gate", deterministic_status: "PASS", visual_status: "PASS", status: "PASS", screenshot: "screenshots/next.png", criteria: ["c"] },
    ],
    error: null,
  };
  reconcileScenarioStatuses(evidence);
  assert.equal(evidence.scenarios[0].status, "FAIL");
}

// scenario aggregation preserves execution errors, rejects zero-gate success,
// and truthfully exposes partial coverage as SKIP.
{
  const errored = evidenceRecord("/tmp/run", {
    scenarios: [{ id: "s3", title: "agent", status: "PASS", duration_ms: 4, error: "stream ended early" }],
    gates: [
      { scenario: "s3", name: "mounted", deterministic_status: "PASS", visual_status: "N/A", status: "PASS", screenshot: null, criteria: [] },
    ],
  });
  finalizeStatus(errored);
  assert.equal(errored.scenarios[0].status, "FAIL", "scenario.error must survive gate reconciliation");
  assert.equal(errored.status, "FAIL");

  const empty = evidenceRecord("/tmp/run", {
    scenarios: [{ id: "s0", title: "startup", status: "PASS", duration_ms: 1, error: null }],
  });
  finalizeStatus(empty);
  assert.equal(empty.scenarios[0].status, "FAIL", "a scenario cannot pass without gate evidence");
  assert.match(empty.scenarios[0].error, /no gate evidence/i);
  assert.equal(empty.status, "FAIL");

  const mixed = evidenceRecord("/tmp/run", {
    scenarios: [{ id: "s3", title: "agent", status: "PASS", duration_ms: 2, error: null }],
    gates: [
      { scenario: "s3", name: "surface", deterministic_status: "PASS", visual_status: "N/A", status: "PASS", screenshot: null, criteria: [] },
      { scenario: "s3", name: "credential", deterministic_status: "SKIP", visual_status: "N/A", status: "SKIP", screenshot: null, criteria: [] },
    ],
  });
  finalizeStatus(mixed);
  assert.equal(mixed.scenarios[0].status, "SKIP", "mixed PASS/SKIP must not claim full scenario PASS");
  assert.equal(mixed.status, "PASS", "an auditable SKIP is a valid non-failing run outcome");
  assert.deepEqual(scenarioResults(mixed), [{ id: "s3", status: "SKIP", duration_ms: 2, error: null }]);

  const report = renderReport(errored);
  assert.match(report, /## Scenarios/);
  assert.match(report, /stream ended early/);
}

// a harness/startup error can never become PASS merely because no gates ran
{
  const evidence = {
    schema: EVIDENCE_SCHEMA,
    status: "FAIL",
    started_at: "",
    finished_at: null,
    output: "/tmp/run",
    app: "/tmp/rho-desktop",
    platform: "test",
    scenarios: [],
    gates: [],
    error: "bridge failed to start",
  };
  finalizeStatus(evidence);
  assert.equal(evidence.status, "FAIL");
}

// evidence model: gate states drive the final status truthfully
{
  const evidence = {
    schema: EVIDENCE_SCHEMA,
    status: "FAIL",
    started_at: new Date().toISOString(),
    finished_at: null,
    app: "/tmp/rho-desktop",
    platform: "test",
    scenarios: [],
    gates: [
      { scenario: "s1", name: "deterministic-only", deterministic_status: "PASS", visual_status: "N/A", status: "PASS", screenshot: null, criteria: [] },
      { scenario: "s1", name: "visual-pass", deterministic_status: "PASS", visual_status: "PASS", status: "PASS", screenshot: "screenshots/a.png", criteria: ["c"] },
      { scenario: "s2", name: "visual-pending", deterministic_status: "PASS", visual_status: "PENDING", status: "PENDING", screenshot: "screenshots/b.png", criteria: ["c"] },
      { scenario: "s3", name: "agent-skip", deterministic_status: "SKIP", visual_status: "N/A", status: "SKIP", screenshot: null, criteria: [] },
    ],
    error: null,
  };
  const summary = summarizeEvidence(evidence);
  assert.equal(summary.gates, 4);
  assert.equal(summary.passed, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.visual_pending, 1);
  const report = renderReport(evidence);
  assert.match(report, /visual-pending/);
  assert.match(report, /PENDING/);
}

// run directories are immutable: a caller must choose a fresh evidence root
{
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rho-visual-existing-run-"));
  try {
    assert.throws(
      () => execFileSync(process.execPath, [
        path.join(repositoryRoot, "scripts", "visual-acceptance.mjs"),
        "run",
        "--app",
        process.execPath,
        "--output",
        temporary,
      ], { stdio: ["ignore", "pipe", "pipe"] }),
      /output directory already exists|exit/i,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// a frame without a recorded visual verdict keeps the run out of PASS
{
  const evidence = evidenceRecord("/tmp/run", {
    scenarios: [{ id: "s1", title: "tour", status: "PASS", duration_ms: 1, error: null }],
    gates: [
      { scenario: "s1", name: "pending", deterministic_status: "PASS", visual_status: "PENDING", status: "PENDING", screenshot: "screenshots/x.png", criteria: [] },
    ],
  });
  assert.equal(summarizeEvidence(evidence).visual_pending, 1, "pending visual review must stay visible");
  finalizeStatus(evidence);
  assert.equal(evidence.scenarios[0].status, "PENDING");
  assert.equal(evidence.status, "FAIL", "finalize must keep a pending frame out of PASS");
}

// A review verdict is accepted only for a captured, intact PNG with explicit
// criteria. Capture failure is irreversible, and finalization revalidates a
// previously reviewed artifact so deleting it cannot leave a false PASS.
{
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rho-visual-review-"));
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    Buffer.from("self-test-frame"),
  ]);
  const makeEvidence = (runDirectory, overrides = {}) => evidenceRecord(runDirectory, {
    scenarios: [{ id: "s1", title: "tour", status: "PENDING", duration_ms: 1, error: null }],
    gates: [{
      scenario: "s1",
      name: "frame",
      deterministic_status: "PASS",
      screenshot_capture_status: "PASS",
      visual_status: "PENDING",
      visual_note: null,
      status: "PENDING",
      error: null,
      screenshot: "screenshots/frame.png",
      screenshot_bytes: png.length,
      criteria: ["the component is visible"],
      ...overrides,
    }],
  });
  try {
    const missingRun = path.join(temporary, "missing");
    writeEvidence(missingRun, makeEvidence(missingRun));
    assert.throws(
      () => reviewFrame(missingRun, "frame"),
      /not reviewable|unreadable|exit/i,
      "a missing screenshot cannot be reviewed into PASS",
    );

    const failedRun = path.join(temporary, "capture-failed");
    writeEvidence(failedRun, makeEvidence(failedRun, { screenshot_capture_status: "FAIL" }));
    fs.writeFileSync(path.join(failedRun, "screenshots", "frame.png"), png);
    assert.throws(
      () => reviewFrame(failedRun, "frame"),
      /not reviewable|capture status|exit/i,
      "an explicit capture failure cannot be overwritten by review",
    );

    const noCriteriaRun = path.join(temporary, "no-criteria");
    writeEvidence(noCriteriaRun, makeEvidence(noCriteriaRun, { criteria: [] }));
    fs.writeFileSync(path.join(noCriteriaRun, "screenshots", "frame.png"), png);
    assert.throws(
      () => reviewFrame(noCriteriaRun, "frame"),
      /not reviewable|criteria|exit/i,
      "a frame without visual criteria cannot be reviewed",
    );

    const validRun = path.join(temporary, "valid");
    writeEvidence(validRun, makeEvidence(validRun));
    const frameFile = path.join(validRun, "screenshots", "frame.png");
    fs.writeFileSync(frameFile, png);
    const review = reviewFrame(validRun, "frame");
    assert.equal(review.visual_status, "PASS");
    assert.equal(review.run_status, "PASS");
    assert.deepEqual(review.scenarios, [{ id: "s1", status: "PASS", duration_ms: 1, error: null }]);

    fs.rmSync(frameFile);
    const finalized = JSON.parse(execFileSync(process.execPath, [
      driverFile,
      "finalize",
      "--run",
      validRun,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    assert.equal(finalized.status, "FAIL", "a reviewed frame removed before finalize invalidates the run");
    assert.deepEqual(finalized.scenarios, [{ id: "s1", status: "FAIL", duration_ms: 1, error: null }]);
    const invalidated = JSON.parse(fs.readFileSync(path.join(validRun, "evidence.json"), "utf8"));
    assert.equal(invalidated.gates[0].screenshot_capture_status, "FAIL");
    assert.equal(invalidated.gates[0].visual_status, "FAIL");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// Lock recovery protects the mkdir -> owner.json creation window, never
// steals a live PID, and reclaims orphaned/corrupt records after the grace.
{
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rho-visual-lock-"));
  const lockDirectory = path.join(temporary, "window.lock");
  const lockOptions = { lockDirectory, timeoutMs: 25, pollIntervalMs: 5 };
  try {
    fs.mkdirSync(lockDirectory);
    fs.writeFileSync(path.join(lockDirectory, "owner.json"), JSON.stringify({ pid: process.pid }));
    await assert.rejects(
      acquireAppLock("contender", { ...lockOptions, orphanGraceMs: 0 }),
      /lock wait timed out/,
      "a live lock owner must not be stolen",
    );
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockDirectory, "owner.json"), "utf8")).pid, process.pid);
    releaseAppLock(lockDirectory);

    fs.mkdirSync(lockDirectory);
    await assert.rejects(
      acquireAppLock("contender", { ...lockOptions, orphanGraceMs: 1_000 }),
      /lock wait timed out/,
      "a fresh ownerless lock must receive a safe creation grace",
    );
    const old = new Date(Date.now() - 5_000);
    fs.utimesSync(lockDirectory, old, old);
    await acquireAppLock("orphan-recovery", { ...lockOptions, orphanGraceMs: 50 });
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockDirectory, "owner.json"), "utf8")).owner, "orphan-recovery");
    releaseAppLock(lockDirectory);

    fs.mkdirSync(lockDirectory);
    const corruptOwner = path.join(lockDirectory, "owner.json");
    fs.writeFileSync(corruptOwner, "{not-json");
    fs.utimesSync(corruptOwner, old, old);
    fs.utimesSync(lockDirectory, old, old);
    await acquireAppLock("corrupt-recovery", { ...lockOptions, orphanGraceMs: 50 });
    assert.equal(JSON.parse(fs.readFileSync(corruptOwner, "utf8")).owner, "corrupt-recovery");
  } finally {
    releaseAppLock(lockDirectory);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// fixture generation equivalence (real generation, temporary root)
{
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rho-visual-fixtures-"));
  const output = path.join(temporary, "fixtures");
  try {
    execFileSync(process.execPath, [
      path.join(repositoryRoot, "test", "acceptance-project", "tools", "prepare-fixtures.mjs"),
      "--output",
      output,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    const working = path.join(output, "working-project");
    const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
    assert.equal(git(working, ["rev-list", "--count", "HEAD"]), "1", "working project has exactly the baseline commit");
    assert.ok(fs.existsSync(path.join(working, "examples", "rho-workbench-tour.R")), "working project carries the tour");

    const conflict = path.join(output, "conflict-project");
    assert.ok(
      git(conflict, ["status", "--porcelain"]).split("\n").includes("UU examples/git-review-demo.txt"),
      "conflict project ships the staged UU conflict",
    );

    const unicode = path.join(output, "路径 含 空格", "acceptance-project");
    assert.ok(fs.existsSync(path.join(unicode, "examples", "rho-workbench-tour.R")), "unicode/space project exists");
    assert.ok(!fs.existsSync(path.join(unicode, ".git")), "unicode project is not a git repository");

    const large = path.join(output, "large-project-2100");
    assert.equal(fs.readdirSync(large).filter((entry) => entry.endsWith(".R")).length, 2100);

    const oversized = path.join(output, "oversized-file-project", "over-8MiB.txt");
    assert.equal(fs.statSync(oversized).size, 9 * 1024 * 1024);

    assert.throws(
      () => execFileSync(process.execPath, [
        path.join(repositoryRoot, "test", "acceptance-project", "tools", "prepare-fixtures.mjs"),
        "--output",
        output,
      ], { stdio: ["ignore", "pipe", "pipe"] }),
      /already exists|exit/i,
      "an existing output root fails closed",
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// bridge fail-closed contract (static source assertions; no build required)
{
  const bridgeSource = fs.readFileSync(path.join(repositoryRoot, "desktop", "src-tauri", "src", "acceptance_bridge.rs"), "utf8");
  const mainSource = fs.readFileSync(path.join(repositoryRoot, "desktop", "src-tauri", "src", "main.rs"), "utf8");
  const workbenchSource = fs.readFileSync(path.join(repositoryRoot, "desktop", "ui", "src", "app", "WorkbenchApp.tsx"), "utf8");
  const automationSource = fs.readFileSync(
    path.join(repositoryRoot, "desktop", "ui", "src", "acceptance", "automation.ts"),
    "utf8",
  );
  assert.match(bridgeSource, /127\.0\.0\.1/, "bridge binds loopback only");
  assert.doesNotMatch(bridgeSource, /0\.0\.0\.0/, "bridge must never bind a wildcard address");
  assert.match(bridgeSource, /RHO_ACCEPTANCE_BRIDGE/, "bridge requires the explicit environment flag");
  assert.match(bridgeSource, /RHO_ACCEPTANCE_OUTPUT/, "bridge requires an explicit output directory");
  assert.match(
    bridgeSource,
    /fn screenshot_not_implemented\(\) -> Response/,
    "the cross-platform screenshot fallback keeps a testable response shape",
  );
  assert.match(
    mainSource,
    /#\[cfg\(debug_assertions\)\][\s\S]{0,400}?acceptance_bridge/,
    "the bridge startup is compile-gated to debug builds",
  );
  assert.match(
    workbenchSource,
    /existing != null && placement != null/,
    "open_surface must not treat an unplaced catalog instance as mounted",
  );
  assert.doesNotMatch(automationSource, /\beval\s*\(/, "the frontend automation surface must not evaluate source text");
  assert.doesNotMatch(automationSource, /\bnew\s+Function\b/, "the automation surface must not synthesize functions");
}

console.log("Visual acceptance harness self-test passed (registry, evidence integrity, locks, fixtures, bridge fail-closed)");
