#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const profileIndex = process.argv.indexOf("--profile");
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : null;
if (profile !== "desktop") {
  console.error("Usage: node test/performance/run.mjs --profile desktop");
  process.exit(2);
}

const errors = [];
const probe = spawnSync(
  "cargo",
  [
    "run",
    "--release",
    "--quiet",
    "--manifest-path",
    "test/performance/probe/Cargo.toml",
  ],
  { cwd: root, encoding: "utf8", timeout: 1_200_000 },
);
if (probe.status !== 0) {
  console.error(probe.stdout, probe.stderr);
  process.exit(1);
}
let raw;
try {
  raw = JSON.parse(probe.stdout);
} catch (error) {
  throw new Error(`performance probe JSON invalid: ${error.message}`);
}
const slo = JSON.parse(await readFile(path.join(root, "test/performance/slo.json"), "utf8"));
for (const [metric, threshold] of Object.entries(slo.thresholds)) {
  const measured = raw.metrics[metric];
  if (!measured) {
    errors.push(`missing_metric:${metric}`);
    continue;
  }
  if (measured.p95_ms > threshold.p95_ms) {
    errors.push(`slo:${metric}:${measured.p95_ms.toFixed(3)}>${threshold.p95_ms}`);
  }
}
const frontend = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["--prefix", "desktop", "run", "rsr:test"],
  { cwd: root, encoding: "utf8", timeout: 300_000 },
);
if (frontend.status !== 0) errors.push("frontend_soak_contracts");
const build = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["--prefix", "desktop", "run", "rsr:build"],
  { cwd: root, encoding: "utf8", timeout: 300_000 },
);
if (build.status !== 0) errors.push("frontend_build");

const baselinePath = path.join(root, "test/performance/baseline-desktop.json");
let baseline = null;
try {
  baseline = JSON.parse(await readFile(baselinePath, "utf8"));
} catch {}
if (baseline) {
  for (const [metric, threshold] of Object.entries(slo.thresholds)) {
    const previous = baseline.metrics?.[metric]?.p95_ms;
    const current = raw.metrics?.[metric]?.p95_ms;
    if (
      typeof previous === "number" &&
      typeof current === "number" &&
      previous > 0 &&
      current > previous * threshold.regression_factor
    ) {
      errors.push(`regression:${metric}:${current.toFixed(3)}>${threshold.regression_factor}x`);
    }
  }
}

const sourceFiles = [
  "crates/rho-control-plane/src/capability_registry.rs",
  "crates/rho-store/src/transactions/mod.rs",
  "crates/rho-artifact-store/src/lib.rs",
];
for (const file of sourceFiles) {
  const source = await readFile(path.join(root, file), "utf8");
  for (const forbidden of ["performance_bypass", "skip_durable_for_speed", "disable_validation_for_benchmark"]) {
    if (source.includes(forbidden)) errors.push(`security_bypass:${file}:${forbidden}`);
  }
}

const report = {
  schema: "rho.performance.desktop-report.v1",
  profile,
  result: errors.length === 0 ? "pass" : "fail",
  hardware: raw.hardware,
  workloads: {
    capability_validation: "capability_argument_validation",
    workspace_run: "durable_append",
    artifact_commit: "cas_commit_4k",
    local_job: "local_process_startup",
    oci_job: "contract benchmark; live availability reported by local-job gate",
    recovery: "projection_recovery",
    sandbox: "sandbox_snapshot_startup",
  },
  distributions: raw.metrics,
  decomposition: {
    queue_runtime_ms: raw.metrics.local_process_startup.p95_ms,
    durable_store_ms: raw.metrics.durable_append.p95_ms,
  },
  thresholds: slo,
  frontend_tests_passed: frontend.status === 0,
  frontend_build_passed: build.status === 0,
  security_invariants_preserved: errors.every((error) => !error.startsWith("security_bypass")),
  errors,
};
const directory = path.join(root, "test/performance/artifacts");
await mkdir(directory, { recursive: true });
const reportPath = path.join(directory, "desktop-performance-report.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(directory, "raw-desktop-probe.json"), `${JSON.stringify(raw, null, 2)}\n`);
try {
  await access(baselinePath);
} catch {
  await writeFile(
    baselinePath,
    `${JSON.stringify({ schema: "rho.performance.baseline.v1", metrics: raw.metrics }, null, 2)}\n`,
  );
}
if (errors.length > 0) {
  console.error(`Desktop performance gate failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(
  `Desktop performance gate passed: ${Object.keys(raw.metrics).length} metrics with p50/p95/p99; artifact ${path.relative(root, reportPath)}`,
);
