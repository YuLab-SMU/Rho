#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const long = process.env.RHO_FUZZ_LONG === "1";
const runs = long ? 100_000 : 2_000;
const maxTime = long ? 900 : 30;
const targets = [
  ["patch_manifest", 524_289],
  ["execution_spec", 524_289],
  ["canonical_event", 1_048_576],
];
const temp = await mkdtemp(path.join(os.tmpdir(), "rho-fuzz-"));
const results = [];
for (const [target, maxLength] of targets) {
  const corpus = path.join(temp, "corpus", target);
  const artifacts = path.join(temp, "artifacts", target);
  await mkdir(path.dirname(corpus), { recursive: true });
  await cp(path.join(root, "fuzz/corpus", target), corpus, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  const started = Date.now();
  const result = spawnSync(
    "cargo",
    [
      "+nightly",
      "fuzz",
      "run",
      "--fuzz-dir",
      "fuzz",
      target,
      corpus,
      "--",
      `-runs=${runs}`,
      `-max_total_time=${maxTime}`,
      `-max_len=${maxLength}`,
      `-artifact_prefix=${artifacts}/`,
    ],
    { cwd: root, encoding: "utf8", timeout: (maxTime + 600) * 1000 },
  );
  results.push({
    target,
    passed: result.status === 0,
    status: result.status,
    runs,
    max_time_seconds: maxTime,
    max_length: maxLength,
    elapsed_ms: Date.now() - started,
    crash_artifacts: [],
  });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    break;
  }
}
const report = {
  schema: "rho.fuzz.report.v1",
  profile: long ? "scheduled_long" : "ci_short",
  sanitizer: "address",
  effect_ports_available: false,
  targets: results,
  passed: results.length === targets.length && results.every((result) => result.passed),
};
const reportDirectory = path.join(root, "test/control-plane/artifacts");
await mkdir(reportDirectory, { recursive: true });
const reportPath = path.join(reportDirectory, "fuzz-report.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
await rm(temp, { recursive: true, force: true });
if (!report.passed) process.exit(1);
console.log(
  `Fuzz targets passed: ${results.map((result) => `${result.target}:${result.runs}`).join(", ")}; artifact ${path.relative(root, reportPath)}`,
);
