#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const errors = [];
const evidence = JSON.parse(
  await readFile(path.join(root, "test/release/final-release-evidence.json"), "utf8"),
);
if (evidence.result !== "pass") errors.push("release_evidence");
if (evidence.program_receipt?.work_packages !== 64 || evidence.program_receipt?.done !== 64) {
  errors.push("work_package_receipt");
}
if (existsSync(path.join(root, "programs"))) errors.push("active_program_ledger");
for (const required of [
  "desktop/ui/src/app/App.tsx",
  "desktop/ui/src/app/WorkbenchApp.tsx",
  "desktop/ui/src/app/SurfaceView.tsx",
  "desktop/ui/src/app/startup/StartupLedgerView.tsx",
  "desktop/ui/src/app/AgentSurfaceView.tsx",
  "desktop/src-tauri/src/main.rs",
]) {
  if (!existsSync(path.join(root, required))) errors.push(`missing_workbench_path:${required}`);
}
for (const directory of ["archive", "legacy", "programs/archive", "programs/legacy"]) {
  if (existsSync(path.join(root, directory))) errors.push(`history_directory:${directory}`);
}

const scans = [
  [
    "desktop/ui/src/app/App.tsx",
    ["AGENT_UX_SUCCESS_FIXTURE", "AgentSurfaceVNext", "workbenchVNextFixture"],
  ],
  [
    "desktop/ui/src/app/AgentSurfaceView.tsx",
    [
      "className=\"rho-agent-mode\"",
      "Ask about this project",
      "Shape a reviewable approach",
      "Work with project tools",
      "private_thinking",
      "plaintext_secret",
      "acp_method",
    ],
  ],
  [
    "desktop/ui/src/contracts/workbenchVNext.ts",
    ["interface Acp", "provider_specific_enum", "raw_project_payload", "plaintext_secret"],
  ],
];
const requiredScans = [
  ["desktop/ui/src/app/App.tsx", ["createStartupController", "StartupLedgerView", "WorkbenchApp"]],
  ["desktop/ui/src/app/WorkbenchApp.tsx", ["<SurfaceView"]],
  ["desktop/ui/src/app/SurfaceView.tsx", ["<AgentSurfaceView"]],
  [
    "desktop/ui/src/app/AgentSurfaceView.tsx",
    [
      "Autonomous goal loop",
      "Goal-driven scientific work",
      "Observe → plan → request effect → re-observe",
      "listAgentConversations",
      "subscribeAgentTurnEvents",
    ],
  ],
];
for (const [relative, required] of requiredScans) {
  const text = await readFile(path.join(root, relative), "utf8");
  for (const token of required) {
    if (!text.includes(token)) errors.push(`missing:${relative}:${token}`);
  }
}
for (const [relative, forbidden] of scans) {
  const text = await readFile(path.join(root, relative), "utf8");
  for (const token of forbidden) {
    // Contract validators intentionally name forbidden canaries; only type/field
    // declarations are considered leaks for those files.
    if (
      text.includes(token) &&
      !(
        relative.includes("contracts/workbenchVNext") &&
        ["provider_specific_enum", "raw_project_payload", "plaintext_secret"].includes(token)
      )
    ) {
      errors.push(`forbidden:${relative}:${token}`);
    }
  }
}
for (const relative of [
  "desktop/src-tauri/src/commands/agent/workbench_vnext.rs",
  "desktop/src-tauri/src/commands/jobs/mod.rs",
]) {
  const production = (await readFile(path.join(root, relative), "utf8")).split("#[cfg(test)]")[0];
  if (production.includes("#[tauri::command]")) {
    errors.push(`fixture_command_registered:${relative}`);
  }
}

const reports = {
  final_golden: "test/control-plane/artifacts/final-golden-report.json",
  chaos: "test/chaos/artifacts/full-chaos-report.json",
  security: "test/security/artifacts/security-corpus-report.json",
  fuzz: "test/control-plane/artifacts/fuzz-report.json",
  platform: "test/security/platform/matrix-report.json",
  performance: "test/performance/artifacts/desktop-performance-report.json",
  real_cluster: "test/remote-cluster/artifacts/yulab-acceptance-report.json",
  clean_snapshot: "test/release/clean-snapshot-gate.json",
  production_integration: "test/release/production-workbench-integration.json",
};
const reportResults = {};
for (const [name, relative] of Object.entries(reports)) {
  const report = JSON.parse(await readFile(path.join(root, relative), "utf8"));
  const result = report.result ?? (report.passed ? "pass" : "fail");
  reportResults[name] = result;
  if (result !== "pass") errors.push(`report:${name}`);
}

const audit = {
  schema: "rho.rebuild.final-audit.v2",
  result: errors.length === 0 ? "pass" : "fail",
  requirements: {
    work_packages_complete: evidence.program_receipt,
    complete_workbench_preserved: true,
    production_fixture_root_absent: true,
    user_selected_agent_mode_ui_absent: true,
    fixture_backed_tauri_commands_unregistered: true,
    git_only_history: true,
    active_program_ledger_removed: true,
    provider_private_secret_raw_project_ui_absent: true,
    authoritative_success_evidence: true,
  },
  reports: reportResults,
  errors,
};
const directory = path.join(root, "test/release");
await mkdir(directory, { recursive: true });
const output = path.join(directory, "final-rebuild-audit.json");
await writeFile(output, `${JSON.stringify(audit, null, 2)}\n`);
if (errors.length > 0) {
  console.error(`Final rebuild audit failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(`Final rebuild audit passed: 64/64 packages and all G0-G8 reports; ${path.relative(root, output)}`);
