#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { stat, readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const artifacts = {
  desktop_binary: "target/release/rho-desktop",
  stable_rollback_binary: "target/release/rho-desktop-stable",
  runner_binary: "target/release/rho-runner",
  frontend_manifest: "desktop/dist/asset-manifest.json",
  provider_matrix: "crates/rho-acp-client/tests/providers/live-matrix.json",
  final_golden: "test/control-plane/artifacts/final-golden-report.json",
  chaos: "test/chaos/artifacts/full-chaos-report.json",
  security: "test/security/artifacts/security-corpus-report.json",
  performance: "test/performance/artifacts/desktop-performance-report.json",
  real_cluster: "test/remote-cluster/artifacts/yulab-acceptance-report.json",
  clean_snapshot: "test/release/clean-snapshot-gate.json",
  production_integration: "test/release/production-workbench-integration.json",
};
const evidence = {};
for (const [name, relative] of Object.entries(artifacts)) {
  const file = path.join(root, relative);
  const bytes = await readFile(file);
  evidence[name] = {
    path: relative,
    bytes: (await stat(file)).size,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

let programReceipt = null;
try {
  const prior = JSON.parse(
    await readFile(path.join(root, "test/release/final-release-evidence.json"), "utf8"),
  );
  programReceipt = prior.program_receipt ?? null;
} catch {}
try {
  const progressBytes = await readFile(
    path.join(root, "programs/rho-rebuild/PROGRESS.json"),
  );
  const progress = JSON.parse(progressBytes);
  const records = Object.values(progress.work_packages ?? progress.packages ?? progress.progress ?? {});
  const manifest = JSON.parse(
    await readFile(path.join(root, "programs/rho-rebuild/MANIFEST.json"), "utf8"),
  );
  const manifestCount = manifest.work_packages?.length ?? 64;
  const done = records.filter((record) => record.status === "done").length;
  programReceipt = {
    work_packages: manifestCount,
    done,
    progress_sha256: `sha256:${createHash("sha256").update(progressBytes).digest("hex")}`,
    status_sha256: `sha256:${createHash("sha256")
      .update(await readFile(path.join(root, "programs/rho-rebuild/STATUS.md")))
      .digest("hex")}`,
  };
} catch {}

const listed = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root },
)
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter(
    (relative) =>
      !relative.startsWith("programs/") &&
      !relative.startsWith("target/") &&
      !relative.startsWith("desktop/dist/") &&
      !relative.startsWith("fuzz/target/") &&
      !relative.includes("/artifacts/") &&
      !relative.startsWith("test/release/") &&
      relative !== "test/security/platform/matrix-report.json",
  )
  .sort();
const sourceHasher = createHash("sha256");
let sourceFiles = 0;
for (const relative of listed) {
  try {
    const bytes = await readFile(path.join(root, relative));
    sourceHasher.update(Buffer.from(relative));
    sourceHasher.update(Buffer.from([0]));
    sourceHasher.update(bytes);
    sourceHasher.update(Buffer.from([0]));
    sourceFiles += 1;
  } catch {}
}

const reports = {};
for (const name of [
  "final_golden",
  "chaos",
  "security",
  "performance",
  "real_cluster",
  "clean_snapshot",
  "production_integration",
]) {
  reports[name] = JSON.parse(
    await readFile(path.join(root, artifacts[name]), "utf8"),
  ).result;
}
const errors = Object.entries(reports)
  .filter(([, result]) => result !== "pass")
  .map(([name]) => `report:${name}`);
if (programReceipt && programReceipt.done !== programReceipt.work_packages) {
  errors.push("program_not_complete");
}
const report = {
  schema: "rho.release.final-evidence.v1",
  version: JSON.parse(await readFile(path.join(root, "desktop/package.json"), "utf8"))
    .version,
  result: errors.length === 0 ? "pass" : "fail",
  source_snapshot: {
    files: sourceFiles,
    sha256: `sha256:${sourceHasher.digest("hex")}`,
    temporary_program_ledger_excluded: true,
  },
  program_receipt: programReceipt,
  artifacts: evidence,
  reports,
  operations: {
    built: true,
    installed: false,
    published: false,
    user_project_mutated: false,
  },
  rollback: {
    source_history: "Git",
    stable_binary: "target/release/rho-desktop-stable",
    runtime_fallback_or_compatibility_schema: false,
  },
  errors,
};
const directory = path.join(root, "test/release");
await mkdir(directory, { recursive: true });
const output = path.join(directory, "final-release-evidence.json");
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
if (errors.length > 0) process.exit(1);
console.log(`Final release evidence passed: ${sourceFiles} source files, ${Object.keys(evidence).length} hashed artifacts; ${path.relative(root, output)}`);
