#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

const fixturePath = path.resolve("test/control-plane/scenarios/golden-path-skeleton.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const errors = [];

const requiredSteps = [
  "goal_submitted",
  "observe",
  "plan",
  "approval_requested",
  "execute",
  "revision_transition",
  "reobserve",
  "artifact_committed",
  "crash_injected",
  "recover",
];
const boundaries = [
  "durable_append",
  "projection_commit",
  "blob_rename",
  "process_spawn",
  "submit_ack",
  "stream_cursor",
];
const timings = ["before", "after"];
const adversarial = [
  "malicious_project",
  "stale_observation",
  "duplicate_operation",
  "slow_consumer",
  "malformed_frame",
];

if (fixture.schema !== "rho.control-plane.scenario.v1") errors.push("schema");
if (fixture.scenario_id !== "golden_path_skeleton") errors.push("scenario_id");
if (fixture.status !== "runnable") errors.push("status");
if (JSON.stringify(fixture.steps) !== JSON.stringify(requiredSteps)) errors.push("steps");
if (fixture.determinism?.fake_clock?.tick_ms !== 50) errors.push("fake_clock");
for (const forbidden of ["sleep", "random_port", "real_cloud_provider"]) {
  if (!fixture.determinism?.forbidden?.includes(forbidden)) errors.push(`missing_forbidden:${forbidden}`);
}
for (const boundary of boundaries) {
  for (const timing of timings) {
    const found = fixture.fault_hooks?.some(
      (hook) => hook.boundary === boundary && hook.timing === timing,
    );
    if (!found) errors.push(`fault_hook:${boundary}:${timing}`);
  }
}
for (const scenarioId of adversarial) {
  const scenario = fixture.adversarial_fixtures?.find((entry) => entry.scenario_id === scenarioId);
  if (!scenario) {
    errors.push(`adversarial:${scenarioId}`);
    continue;
  }
  if (scenario.status !== "expected_failure") errors.push(`adversarial_status:${scenarioId}`);
  if (!scenario.skip_reason) errors.push(`adversarial_reason:${scenarioId}`);
}

if (errors.length > 0) {
  console.error(`Scenario fixture check failed: ${errors.join(", ")}`);
  process.exit(1);
}
console.log(`Scenario fixture check passed: ${fixturePath}`);
