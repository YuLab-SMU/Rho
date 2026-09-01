#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const report = JSON.parse(await readFile(
  path.join(root, "test/remote-cluster/artifacts/yulab-acceptance-report.json"),
  "utf8",
));
assert.equal(report.schema, "rho.remote-cluster.environment-acceptance.v2");
assert.equal(report.profile, "yulab");
assert.equal(report.result, "pass");
assert.equal(report.job.state, "COMPLETED");
assert.equal(report.job.exit_code, "0:0");
assert.notEqual(report.job.compute_host, "master");
assert.equal(report.job.submit_count, 1);
assert.equal(report.job.export_policy, "NIL");
assert.equal(report.environment.namespace_probe, "passed");
assert.equal(report.environment.offline_inputs_verified, true);
assert.equal(report.environment.network_policy_requested, "deny");
assert.equal(report.environment.network_enforcement, "proxy_environment_only");
assert.ok(report.limitations.some((value) => value.includes("did not prove kernel-level")));

for (const artifact of Object.values(report.artifacts)) {
  const bytes = await readFile(path.join(root, artifact.path));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
}
const receipt = JSON.parse(await readFile(
  path.join(root, report.artifacts.receipt.path),
  "utf8",
));
assert.equal(receipt.slurm_job_id, report.job.job_id);
assert.equal(receipt.compute_host, report.job.compute_host);
assert.equal(receipt.outcome, "succeeded");
const accounting = (await readFile(path.join(root, report.artifacts.sacct.path), "utf8"))
  .trim()
  .split("|");
assert.deepEqual(accounting.slice(0, 3), [report.job.job_id, "COMPLETED", "0:0"]);

const harness = await readFile(path.join(root, report.acceptance_script.path));
assert.equal(
  createHash("sha256").update(harness).digest("hex"),
  report.acceptance_script.sha256,
);
console.log(`YuLab Environment evidence verified: job ${report.job.job_id} on ${report.job.compute_host}`);
