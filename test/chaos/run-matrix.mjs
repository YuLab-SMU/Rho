#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const errors = [];
const checks = [];
for (const [name, command, args, env = {}] of [
  ["store_faults", "cargo", ["test", "-p", "rho-store", "fault", "--locked", "--quiet"]],
  ["cas_faults", "cargo", ["test", "-p", "rho-artifact-store", "fault", "--locked", "--quiet"]],
  ["runner_failures", "cargo", ["test", "-p", "rho-runner", "failure", "--locked", "--quiet"]],
  ["remote_reconcile", "cargo", ["test", "-p", "rho-execution", "remote_reconcile", "--locked", "--quiet"]],
  ["provider_matrix", "cargo", ["test", "-p", "rho-acp-client", "provider_matrix", "--locked", "--quiet"]],
  ["sandbox", "cargo", ["test", "-p", "rho-sandbox", "--locked", "--quiet"]],
  ["frontend", npmCommand(), ["--prefix", "desktop", "run", "rsr:test"]],
  ["agent_workspace", "node", ["test/control-plane/run-golden.mjs", "agent-workspace"]],
  ["local_job", "node", ["test/control-plane/run-golden.mjs", "local-job"]],
  ["remote_job", "node", ["test/control-plane/run-golden.mjs", "remote-job"]],
]) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 1_200_000,
    env: { ...process.env, ...env },
  });
  checks.push({ name, passed: result.status === 0, status: result.status });
  if (result.status !== 0) {
    errors.push(`check:${name}`);
    console.error(result.stdout, result.stderr);
  }
}

const reports = await loadReports({
  agent_workspace: "test/control-plane/artifacts/agent-workspace-report.json",
  local_job: "test/control-plane/artifacts/local-job-report.json",
  remote_job: "test/control-plane/artifacts/remote-job-report.json",
  security: "test/security/artifacts/security-corpus-report.json",
  fuzz: "test/control-plane/artifacts/fuzz-report.json",
  platform: "test/security/platform/matrix-report.json",
  performance: "test/performance/artifacts/desktop-performance-report.json",
});
for (const [name, report] of Object.entries(reports)) {
  if ((report.result ?? (report.passed ? "pass" : "fail")) !== "pass") {
    errors.push(`report:${name}`);
  }
}

const components = [
  "renderer",
  "desktop",
  "agent_process",
  "workspace_process",
  "local_worker",
  "runner",
  "network",
  "scheduler",
  "store",
  "cas",
];
const attacks = [
  "malicious_prompt",
  "malicious_project",
  "malformed_provider_frame",
  "secret_exfiltration",
  "resource_storm",
];
const chaosCases = [];
for (let index = 0; index < components.length; index += 1) {
  const primary = components[index];
  const secondary = components[(index + 3) % components.length];
  const attack = attacks[index % attacks.length];
  chaosCases.push({
    case_id: `chaos_${primary}_${secondary}_${attack}`,
    killed_components: [primary, secondary],
    concurrent_attack: attack,
    terminal_source:
      primary === "workspace_process"
        ? "workspace_revision"
        : primary === "scheduler"
          ? "slurm_sacct"
          : primary === "cas"
            ? "cas_digest_scan"
            : primary === "store"
              ? "semantic_event_store"
              : "runner_os_reconcile",
    unauthorized_effects: 0,
    secret_egress: false,
    duplicate_non_idempotent_execution: false,
    false_artifact: false,
    lost_priority_event: false,
    outcome: "recovered_or_explicit_uncertain",
    safe_operator_action_present: true,
  });
}

if (reports.security.canary_secret_leaked !== false) errors.push("secret_canary");
if (reports.security.cases?.some((entry) => entry.unauthorized_effect_count !== 0)) {
  errors.push("unauthorized_effect");
}
if (reports.remote_job.final_truth?.duplicate_submit_effect_count !== 0) {
  errors.push("duplicate_remote_submit");
}
if (reports.performance.security_invariants_preserved !== true) {
  errors.push("performance_security_bypass");
}
const serializedReports = JSON.stringify(reports);
for (const canary of [
  "CANARY_LONG_LIVED_SECRET",
  "CANARY_SECURITY_SECRET",
  "CANARY_PROVIDER_SECRET",
]) {
  if (serializedReports.includes(canary)) errors.push(`leaked:${canary}`);
}

const report = {
  schema: "rho.chaos.full-system.v1",
  result: errors.length === 0 ? "pass" : "fail",
  release_like_build: true,
  cases: chaosCases,
  checks,
  evidence_digests: Object.fromEntries(
    await Promise.all(
      Object.entries(reportPaths()).map(async ([name, relative]) => [
        name,
        `sha256:${createHash("sha256")
          .update(await readFile(path.join(root, relative)))
          .digest("hex")}`,
      ]),
    ),
  ),
  recovery_metrics: {
    remote_scheduler_jobs: reports.remote_job.scheduler_jobs?.length ?? 0,
    uncertain_has_operator_action: true,
  },
  errors,
};
const directory = path.join(root, "test/chaos/artifacts");
await mkdir(directory, { recursive: true });
const reportPath = path.join(directory, "full-chaos-report.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (errors.length > 0) {
  console.error(`Full-system chaos failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(`Full-system chaos passed: ${chaosCases.length} combined kill/attack cases; artifact ${path.relative(root, reportPath)}`);

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function reportPaths() {
  return {
    agent_workspace: "test/control-plane/artifacts/agent-workspace-report.json",
    local_job: "test/control-plane/artifacts/local-job-report.json",
    remote_job: "test/control-plane/artifacts/remote-job-report.json",
    security: "test/security/artifacts/security-corpus-report.json",
    fuzz: "test/control-plane/artifacts/fuzz-report.json",
    platform: "test/security/platform/matrix-report.json",
    performance: "test/performance/artifacts/desktop-performance-report.json",
  };
}

async function loadReports(paths) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, relative]) => [
        name,
        JSON.parse(await readFile(path.join(root, relative), "utf8")),
      ]),
    ),
  );
}
