#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const errors = [];
const requiredPaths = [
  "desktop/ui/src/app/App.tsx",
  "desktop/ui/src/app/WorkbenchApp.tsx",
  "desktop/ui/src/app/SurfaceView.tsx",
  "desktop/ui/src/app/startup/StartupLedgerView.tsx",
  "desktop/ui/src/app/AgentSurfaceView.tsx",
  "desktop/src-tauri/src/main.rs",
];
for (const required of requiredPaths) {
  if (!existsSync(path.join(root, required))) errors.push(`full Workbench path is missing: ${required}`);
}

const app = await source("desktop/ui/src/app/App.tsx");
for (const required of ["createStartupController", "StartupLedgerView", "WorkbenchApp"]) {
  if (!app.includes(required)) errors.push(`production App does not retain ${required}`);
}
for (const forbidden of ["AGENT_UX_SUCCESS_FIXTURE", "AgentSurfaceVNext", "workbenchVNextFixture"]) {
  if (app.includes(forbidden)) errors.push(`production App mounts fixture path ${forbidden}`);
}

const workbench = await source("desktop/ui/src/app/WorkbenchApp.tsx");
const router = await source("desktop/ui/src/app/SurfaceView.tsx");
const agent = await source("desktop/ui/src/app/AgentSurfaceView.tsx");
if (!workbench.includes("<SurfaceView")) errors.push("WorkbenchApp does not route real surfaces");
if (!router.includes("<AgentSurfaceView")) errors.push("SurfaceView does not mount the Agent subsystem");
for (const required of [
  "Autonomous goal loop",
  "Goal-driven scientific work",
  "Observe → plan → request effect → re-observe",
  "listAgentConversations",
  "subscribeAgentTurnEvents",
]) {
  if (!agent.includes(required)) errors.push(`Agent integration is missing ${JSON.stringify(required)}`);
}
for (const removed of [
  'className="rho-agent-mode"',
  "Ask about this project",
  "Shape a reviewable approach",
  "Work with project tools",
]) {
  if (agent.includes(removed)) errors.push(`Agent still exposes removed workflow mode ${JSON.stringify(removed)}`);
}

for (const harness of [
  "desktop/src-tauri/src/commands/agent/workbench_vnext.rs",
  "desktop/src-tauri/src/commands/jobs/mod.rs",
]) {
  const text = await source(harness);
  const production = text.split("#[cfg(test)]")[0];
  if (production.includes("#[tauri::command]")) {
    errors.push(`fixture-backed harness is registered as a production command: ${harness}`);
  }
}

const manifest = await source("Cargo.toml");
for (const banned of ["legacy", "archive", "v_old"]) {
  const memberPattern = new RegExp(`crates/[^"\\n]*${banned}`, "i");
  if (memberPattern.test(manifest)) errors.push(`workspace introduces a ${banned} crate`);
}

if (errors.length > 0) {
  console.error(`Agent production integration failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(
  "Agent production integration passed: the complete Workbench is the production root, "
  + "the Agent uses one autonomous real-transport surface, and fixture-backed commands are not shipped.",
);

async function source(relativePath) {
  return readFile(path.join(root, relativePath), "utf8").catch(() => "");
}
