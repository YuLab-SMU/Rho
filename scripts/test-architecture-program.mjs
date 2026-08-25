import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ProgramValidationError,
  checkLineBudget,
  checkOverlap,
  countLines,
  nextPayload,
  parseRecord,
  pathMatchesPattern,
  statusPayload,
  validateProgram,
} from "./architecture-program.mjs";

const DATE = "2026-08-24";
const BASE = "9a5da6dfb7bf9a50a42bff02dac63f2c2c28dc52";

function program(overrides = {}) {
  return {
    schema_version: 1,
    record_type: "program",
    program_id: "AM-2026",
    status: "active",
    current_wave: 0,
    authorized_at: DATE,
    authorized_by: "test owner",
    authorization_source: "fixture",
    active_work_packages: ["AM-W0-01"],
    integration_lane: "AM-W0-01",
    base_commit: BASE,
    _file: "docs/architecture/active-2026-08-24-architecture-modernization-program.md",
    ...overrides,
  };
}

function workPackage(overrides = {}) {
  return {
    schema_version: 1,
    record_type: "work_package",
    id: "AM-W0-01",
    title: "Fixture package",
    status: "active",
    wave: 0,
    change_class: "D3",
    risk: "R3",
    lane: "integration",
    base_commit: BASE,
    depends_on: [],
    integration_dependencies: [],
    owned_paths: ["src/a/**"],
    shared_write_paths: [],
    findings: ["AM-F-0001"],
    contracts: [],
    validation_commands: ["node fixture"],
    version_decision: "none",
    news_decision: "none",
    residual_risks: ["AM-F-0001"],
    evidence: [],
    commits: [],
    status_history: [
      { status: "proposed", at: DATE, reason: "fixture proposed" },
      { status: "ready", at: DATE, reason: "fixture ready" },
      { status: "active", at: DATE, reason: "fixture active" },
    ],
    _file: "docs/architecture/modernization/work-packages/AM-W0-01.md",
    ...overrides,
  };
}

function finding(overrides = {}) {
  return {
    schema_version: 1,
    record_type: "finding",
    id: "AM-F-0001",
    title: "Fixture finding",
    severity: "high",
    category: "fixture",
    acceptance_domains: ["product_correctness"],
    discovered_at: DATE,
    discovered_in: "fixture",
    evidence: ["fixture reproduction"],
    impact: "fixture impact",
    disposition_work_package: "AM-W0-01",
    target_wave: 0,
    tests: ["fixture test"],
    commits: [],
    status: "active",
    status_history: [
      { status: "observed", at: DATE, reason: "fixture observed" },
      { status: "triaged", at: DATE, reason: "fixture triaged" },
      { status: "active", at: DATE, reason: "fixture active" },
    ],
    _file: "docs/architecture/modernization/findings/AM-F-0001.md",
    ...overrides,
  };
}

function decision(overrides = {}) {
  return {
    schema_version: 1,
    record_type: "decision",
    id: "AM-D-0001",
    title: "Fixture ratchet",
    status: "accepted",
    decided_at: DATE,
    decision: "test",
    rationale: "test",
    consequences: ["test"],
    line_budget: {
      enforcement: "advisory",
      production_roots: [],
      production_extensions: [".ts"],
      generated_segments: [],
      test_segments: [".test."],
      production_suggested_lines: 8,
      production_attention_lines: 10,
      test_attention_lines: 20,
      legacy_review_growth_lines: 2,
      legacy_review_growth_percent: 10,
      legacy_attention_growth_lines: 4,
      legacy_attention_growth_percent: 25,
      exceptions: [],
    },
    _file: "docs/architecture/modernization/decisions/AM-D-0001.md",
    ...overrides,
  };
}

function validRecords() {
  return [program(), finding(), workPackage(), decision()];
}

function expectInvalid(records, pattern) {
  assert.throws(
    () => validateProgram(records, { root: process.cwd(), lineBudget: false }),
    (error) => error instanceof ProgramValidationError && pattern.test(error.message),
  );
}

function runValidationFixtures() {
  const context = validateProgram(validRecords(), { root: process.cwd(), lineBudget: false });
  assert.equal(context.findings.length, 1);
  assert.equal(context.packages.length, 1);

  expectInvalid([
    program({ integration_lane: "AM-W9-99" }),
    finding(),
    workPackage(),
    decision(),
  ], /unknown integration_lane AM-W9-99/u);

  expectInvalid([
    program(),
    finding({ id: "bad", _file: "docs/architecture/modernization/findings/bad.md" }),
    workPackage({ findings: ["bad"], residual_risks: ["bad"] }),
    decision(),
  ], /invalid finding id bad/u);

  const duplicate = finding({
    _file: "docs/architecture/modernization/findings/AM-F-0001-copy.md",
  });
  expectInvalid([...validRecords(), duplicate], /duplicate record ID AM-F-0001/u);

  expectInvalid([
    program(),
    finding({
      status: "resolved",
      commits: ["abcdef0"],
      status_history: [
        { status: "observed", at: DATE, reason: "observed" },
        { status: "resolved", at: DATE, reason: "skipped gates" },
      ],
    }),
    workPackage(),
    decision(),
  ], /illegal status transition observed -> resolved/u);

  expectInvalid([
    program(),
    finding({ disposition_work_package: "AM-W9-99" }),
    workPackage(),
    decision(),
  ], /unknown disposition package AM-W9-99/u);

  expectInvalid([
    program(),
    finding({ acceptance_domains: undefined }),
    workPackage(),
    decision(),
  ], /acceptance_domains must be an array/u);

  expectInvalid([
    program(),
    finding({ acceptance_domains: ["schedule_pressure"] }),
    workPackage(),
    decision(),
  ], /invalid acceptance domain schedule_pressure/u);

  const overdue = validateProgram([
    program({ current_wave: 1 }),
    finding({ target_wave: 0 }),
    workPackage(),
    decision(),
  ], { root: process.cwd(), lineBudget: false });
  assert.match(overdue.warnings.join("\n"), /finding target wave 0 has passed; replan or resolve it/u);

  const baseDecision = decision();
  const hotspotReview = validateProgram([
    program({ current_wave: 1 }),
    finding({ target_wave: 1 }),
    workPackage(),
    decision({
      line_budget: {
        ...baseDecision.line_budget,
        exceptions: [{
          path: "src/legacy.ts",
          baseline_lines: 8,
          target_lines: 4,
          finding: "AM-F-0001",
          removal_work_package: "AM-W0-01",
          expires_wave: 0,
        }],
      },
    }),
  ], { root: process.cwd(), lineBudget: false });
  assert.match(hotspotReview.warnings.join("\n"), /hotspot src\/legacy\.ts passed review wave 0/u);

  expectInvalid([
    program(),
    finding(),
    workPackage(),
    decision({ line_budget: { ...baseDecision.line_budget, enforcement: "blocking" } }),
  ], /line_budget\.enforcement must be advisory/u);
}

function evidence() {
  return {
    schema_version: 1,
    record_type: "evidence",
    id: "AM-E-0001",
    work_package_id: "AM-W0-01",
    status: "passed",
    platform: "fixture",
    source_commit: "WORKTREE",
    recorded_at: DATE,
    commands: [{ command: "fixture", result: "passed" }],
    unrun_checks: [],
    _file: "docs/architecture/modernization/evidence/AM-E-0001.md",
  };
}

function runCompletionAndDependencyFixtures() {
  expectInvalid([
    program({ active_work_packages: [] }),
    finding({ severity: "low" }),
    workPackage({
      status: "implemented",
      evidence: ["AM-E-0001"],
      commits: ["abcdef0"],
      status_history: [
        { status: "proposed", at: DATE, reason: "proposed" },
        { status: "ready", at: DATE, reason: "ready" },
        { status: "active", at: DATE, reason: "active" },
        { status: "verifying", at: DATE, reason: "verifying" },
        { status: "implemented", at: DATE, reason: "implemented" },
      ],
    }),
    decision(),
    evidence(),
  ], /implemented package retains hard-domain findings AM-F-0001/u);

  const advisoryImplemented = workPackage({
    status: "implemented",
    evidence: ["AM-E-0001"],
    commits: ["abcdef0"],
    status_history: [
      { status: "proposed", at: DATE, reason: "proposed" },
      { status: "ready", at: DATE, reason: "ready" },
      { status: "active", at: DATE, reason: "active" },
      { status: "verifying", at: DATE, reason: "verifying" },
      { status: "implemented", at: DATE, reason: "implemented" },
    ],
  });
  const advisoryContext = validateProgram([
    program({ active_work_packages: [] }),
    finding({ severity: "high", acceptance_domains: [] }),
    advisoryImplemented,
    decision(),
    evidence(),
  ], { root: process.cwd(), lineBudget: false });
  assert.equal(statusPayload(advisoryContext).findings[0].acceptance, "advisory");
  assert.deepEqual(statusPayload(advisoryContext).findings[0].acceptance_domains, []);

  const implemented = workPackage({
    status: "implemented",
    findings: [],
    residual_risks: [],
    evidence: ["AM-E-0001"],
    commits: ["abcdef0"],
    status_history: [
      { status: "proposed", at: DATE, reason: "proposed" },
      { status: "ready", at: DATE, reason: "ready" },
      { status: "active", at: DATE, reason: "active" },
      { status: "verifying", at: DATE, reason: "verifying" },
      { status: "implemented", at: DATE, reason: "implemented" },
    ],
  });
  const next = workPackage({
    id: "AM-W1-01",
    status: "proposed",
    wave: 1,
    depends_on: ["AM-W0-01"],
    findings: [],
    residual_risks: [],
    owned_paths: ["src/b/**"],
    status_history: [{ status: "proposed", at: DATE, reason: "proposed" }],
    _file: "docs/architecture/modernization/work-packages/AM-W1-01.md",
  });
  const records = [program({ active_work_packages: [] }), implemented, next, decision(), evidence()];
  const context = validateProgram(records, { root: process.cwd(), lineBudget: false });
  assert.deepEqual(nextPayload(context), {
    active: [],
    verifying: [],
    ready: [],
    eligible_for_ready: ["AM-W1-01"],
  });
}

function runOverlapFixtures() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rho-architecture-overlap-"));
  try {
    fs.mkdirSync(path.join(temporary, "src/shared"), { recursive: true });
    fs.writeFileSync(path.join(temporary, "src/shared/value.ts"), "export {};\n");
    const first = workPackage();
    const second = workPackage({
      id: "AM-W0-02",
      owned_paths: ["src/**"],
      findings: [],
      residual_risks: [],
      _file: "docs/architecture/modernization/work-packages/AM-W0-02.md",
    });
    const overlap = checkOverlap([first, second], { root: temporary });
    assert.equal(overlap.collisions.length, 1);
    assert.deepEqual(overlap.collisions[0].packages, ["AM-W0-01", "AM-W0-02"]);

    const paths = checkOverlap([first], {
      root: temporary,
      workPackageId: "AM-W0-01",
      changed: ["src/a/new.ts", "src/other.ts"],
    });
    assert.deepEqual(paths.undeclared_paths, ["src/other.ts"]);
    assert.equal(paths.registered_base_commit, BASE);
    assert.equal(paths.base_mismatch, null);
    assert(pathMatchesPattern("src/a/new.ts", "src/a/**"));
    assert(!pathMatchesPattern("src/b/new.ts", "src/a/**"));

    const mismatchedBase = checkOverlap([first], {
      root: temporary,
      workPackageId: "AM-W0-01",
      baseCommit: "abcdef0",
    });
    assert.deepEqual(mismatchedBase.base_mismatch, {
      declared: BASE,
      actual: "abcdef0",
    });

    const feature = workPackage({
      lane: "feature",
      shared_write_paths: ["NEWS.md", "Cargo.lock"],
    });
    const forbiddenShared = checkOverlap([feature], {
      root: temporary,
      workPackageId: feature.id,
      changed: ["NEWS.md", "Cargo.lock"],
    });
    assert.deepEqual(forbiddenShared.forbidden_shared_paths, ["Cargo.lock", "NEWS.md"]);
    assert.deepEqual(forbiddenShared.integration_lane_paths, []);

    const integration = workPackage({
      shared_write_paths: ["NEWS.md"],
    });
    const allowedShared = checkOverlap([integration], {
      root: temporary,
      workPackageId: integration.id,
      changed: ["NEWS.md"],
    });
    assert.deepEqual(allowedShared.integration_lane_paths, ["NEWS.md"]);
    assert.deepEqual(allowedShared.forbidden_shared_paths, []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function repeatedLines(count) {
  return Array.from({ length: count }, (_, index) => `line ${index}`).join("\n") + "\n";
}

function runLineBudgetFixtures() {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("one"), 1);
  assert.equal(countLines("one\ntwo\n"), 2);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rho-architecture-lines-"));
  try {
    fs.mkdirSync(path.join(temporary, "src"), { recursive: true });
    fs.writeFileSync(path.join(temporary, "src/new.ts"), repeatedLines(11));
    fs.writeFileSync(path.join(temporary, "src/legacy.ts"), repeatedLines(13));
    const config = {
      enforcement: "advisory",
      production_roots: ["src"],
      production_extensions: [".ts"],
      generated_segments: [],
      test_segments: [".test."],
      production_suggested_lines: 8,
      production_attention_lines: 10,
      test_attention_lines: 20,
      legacy_review_growth_lines: 2,
      legacy_review_growth_percent: 10,
      legacy_attention_growth_lines: 4,
      legacy_attention_growth_percent: 25,
      exceptions: [{ path: "src/legacy.ts", baseline_lines: 8 }],
    };
    const result = checkLineBudget(temporary, config);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.warnings, [
      "src/legacy.ts: 13 lines exceeds legacy attention threshold 10 (baseline 8)",
      "src/new.ts: 11 lines exceeds attention threshold 10",
    ]);
    fs.writeFileSync(path.join(temporary, "src/legacy.ts"), repeatedLines(10));
    assert.deepEqual(checkLineBudget(temporary, config).warnings, [
      "src/legacy.ts: 10 lines exceeds legacy review threshold 9 (baseline 8)",
      "src/new.ts: 11 lines exceeds attention threshold 10",
    ]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function runMetadataFixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rho-architecture-json-"));
  try {
    const valid = path.join(temporary, "record.md");
    fs.writeFileSync(valid, "# Record\n\n```json\n{\"record_type\":\"decision\"}\n```\n");
    assert.equal(parseRecord(valid, temporary).record_type, "decision");
    const invalid = path.join(temporary, "invalid.md");
    fs.writeFileSync(invalid, "# Record\n\n```json\n{record_type: decision}\n```\n");
    assert.throws(() => parseRecord(invalid, temporary), /invalid JSON metadata/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function runDeterminismFixture() {
  const context = validateProgram(validRecords(), { root: process.cwd(), lineBudget: false });
  const first = `${JSON.stringify(statusPayload(context), null, 2)}\n`;
  const second = `${JSON.stringify(statusPayload(context), null, 2)}\n`;
  assert.equal(first, second);

  const historicalFinding = finding({
    status: "resolved",
    commits: ["abcdef0"],
    status_history: [
      { status: "observed", at: DATE, reason: "observed" },
      { status: "triaged", at: DATE, reason: "triaged" },
      { status: "active", at: DATE, reason: "active" },
      { status: "verifying", at: DATE, reason: "verifying" },
      { status: "resolved", at: DATE, reason: "resolved" },
    ],
  });
  delete historicalFinding.acceptance_domains;
  const historical = validateProgram([
    program({ active_work_packages: [] }),
    historicalFinding,
    workPackage({
      status: "implemented",
      evidence: ["AM-E-0001"],
      commits: ["abcdef0"],
      status_history: [
        { status: "proposed", at: DATE, reason: "proposed" },
        { status: "ready", at: DATE, reason: "ready" },
        { status: "active", at: DATE, reason: "active" },
        { status: "verifying", at: DATE, reason: "verifying" },
        { status: "implemented", at: DATE, reason: "implemented" },
      ],
    }),
    decision(),
    evidence(),
  ], { root: process.cwd(), lineBudget: false });
  assert.equal(statusPayload(historical).findings[0].acceptance, "historical");
}

runValidationFixtures();
runCompletionAndDependencyFixtures();
runOverlapFixtures();
runLineBudgetFixtures();
runMetadataFixture();
runDeterminismFixture();

console.log("Architecture program self-tests passed");
