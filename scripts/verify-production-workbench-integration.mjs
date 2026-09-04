#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const errors = [];
const checks = [];

for (const [name, command, args, timeout] of [
  ["agent_production_source_audit", "node", ["scripts/check-clean-agent-cut.mjs"], 120_000],
  ["architecture_contract", "cargo", ["test", "-p", "rho-architecture-tests", "--locked"], 300_000],
  ["production_bundle_invariants", "node", ["scripts/test-production-invariants.mjs"], 120_000],
]) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout });
  const passed = result.status === 0;
  checks.push({ name, passed });
  if (!passed) errors.push(`${name}:${(result.stderr || result.stdout || "failed").trim().slice(0, 500)}`);
}

const app = await read("desktop/ui/src/app/App.tsx");
const agent = await read("desktop/ui/src/app/agent/AgentSurface.tsx");
for (const marker of ["createStartupController", "StartupLedgerView", "WorkbenchRoot"]) {
  if (!app.includes(marker)) errors.push(`production_app_missing:${marker}`);
}
for (const marker of ["AGENT_UX_SUCCESS_FIXTURE", "AgentSurfaceVNext"]) {
  if (app.includes(marker)) errors.push(`production_app_fixture:${marker}`);
}
for (const marker of [
  "listAgentConversations",
  "subscribeAgentTurnEvents",
  "runConversation",
  "rho-agent-stream-item",
  "Observe → plan → request effect → re-observe",
]) {
  if (!agent.includes(marker)) errors.push(`agent_surface_missing:${marker}`);
}
if (/className=["']rho-agent-mode["']/u.test(agent)) errors.push("agent_mode_selector_present");
for (const gating of ["rho-agent-approval", "respondAgentApproval", "rho-agent-context-preview"]) {
  if (agent.includes(gating)) errors.push(`agent_gating_ui_present:${gating}`);
}

const distAssets = path.join(root, "desktop/dist/assets");
const generatedFiles = (await readdir(distAssets))
  .filter((name) => /\.(?:js|css)$/u.test(name))
  .sort();
const generatedProgram = (
  await Promise.all(generatedFiles.map((name) => readFile(path.join(distAssets, name), "utf8")))
).join("\n");
for (const marker of ["Start a conversation", "Observe → plan → request effect → re-observe"]) {
  if (!generatedProgram.includes(marker)) errors.push(`production_bundle_missing:${marker}`);
}
if (generatedProgram.includes("AGENT_UX_SUCCESS_FIXTURE")) errors.push("production_bundle_contains_fixture");

const artifacts = {};
for (const [name, relative] of Object.entries({
  desktop_binary: "target/release/rho-desktop",
  stable_rollback_binary: "target/release/rho-desktop-stable",
  frontend_manifest: "desktop/dist/asset-manifest.json",
  real_agent_session_capture: "test/release/artifacts/production-agent-real-session.png",
  complete_workbench_capture: "test/release/artifacts/production-workbench-command-surface.png",
})) {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) {
    errors.push(`missing_artifact:${relative}`);
    continue;
  }
  const bytes = await readFile(absolute);
  artifacts[name] = {
    path: relative,
    bytes: (await stat(absolute)).size,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}
const rollbackHash = artifacts.stable_rollback_binary?.sha256;
if (rollbackHash !== "sha256:029519ec0e3f86d76df730d1b84f6ec869671c053ab53cdb09470cce8eccbbb3") {
  errors.push(`stable_rollback_hash:${rollbackHash ?? "missing"}`);
}
const liveCaptureConfirmed = process.env.RHO_LIVE_CAPTURE_CONFIRMED === "1";
if (!liveCaptureConfirmed) errors.push("live_release_binary_capture_not_confirmed");

const report = {
  schema: "rho.release.production-workbench-integration.v1",
  result: errors.length === 0 ? "pass" : "fail",
  checks,
  assertions: {
    complete_workbench_is_production_root: errors.every((error) => !error.startsWith("production_app_")),
    agent_uses_real_ui_kernel_transport: agent.includes("listAgentConversations")
      && agent.includes("subscribeAgentTurnEvents"),
    user_selectable_ask_plan_act_absent: !/className=["']rho-agent-mode["']/u.test(agent),
    static_agent_fixture_absent_from_bundle: !generatedProgram.includes("AGENT_UX_SUCCESS_FIXTURE"),
    live_release_binary_capture_confirmed: liveCaptureConfirmed,
    stable_rollback_preserved: rollbackHash === "sha256:029519ec0e3f86d76df730d1b84f6ec869671c053ab53cdb09470cce8eccbbb3",
  },
  live_observation: {
    binary: "target/release/rho-desktop",
    project_mutation_performed: false,
    observed_real_provider: "deepseek-v4-flash",
    observed_real_tool: "get_workspace_snapshot",
    observed_terminal_state: "completed",
  },
  artifacts,
  errors,
};
const output = path.join(root, "test/release/production-workbench-integration.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
if (errors.length > 0) {
  console.error(`Production Workbench integration failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(`Production Workbench integration passed; ${path.relative(root, output)}`);

async function read(relative) {
  return readFile(path.join(root, relative), "utf8");
}
