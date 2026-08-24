import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(repositoryRoot, path), "utf8");

export function validateAgentDependencyDiagnostics(value) {
  for (const marker of [
    "struct AgentDependencyStatus", '"missing"', '"incompatible_version"',
    '"namespace_load_failed"', '"incompatible_api"', "resolved_path", "remediation",
    "CRAN-only", "Workspace R remains available", "fn agent_runtime_status", "agent_runtime_retry",
  ]) assert.ok(value.rust.includes(marker), `Agent dependency backend lost ${marker}`);
  assert.doesNotMatch(value.probe, /stop\s*\(/u, "optional package health must not abort the probe");

  for (const marker of [
    "AgentRuntimeDiagnostics", "getAgentRuntimeDiagnostics", "Dependency details",
    "Copy diagnostics", "installed:", "required:  >=", "status:", "path:",
    "Provider adapters:", "Workspace R remains independent",
  ]) assert.ok(value.frontend.includes(marker), `Agent Surface diagnostics lost ${marker}`);
  for (const marker of [
    "incompatible_version", "1.4.12", "1.5.0", "CRAN currently provides 1.4.12",
    "aisdk.providers", "missing", "/project/renv/library/R-4.6/aarch64-apple-darwin/aisdk",
  ]) assert.ok(value.mock.includes(marker), `browser diagnostics fixture lost ${marker}`);
  assert.match(value.transport, /createTauriAgentRuntimeTransport/u);
  assert.match(value.transport, /"agent_runtime_status"/u);
  assert.match(value.transport, /"agent_runtime_retry"/u);
  assert.match(value.contractTest, /CRAN currently provides 1\.4\.12/u);
  assert.match(value.contractTest, /required:  >= 1\.5\.0/u);
  assert.match(value.spec, /Issue #94 owns canonical Agent dependency manifests/u);
  assert.match(value.spec, /Issue #93 owns Workspace R\/Ark supervision/u);
}

const fixture = () => ({
  rust: 'struct AgentDependencyStatus "missing" "incompatible_version" "namespace_load_failed" "incompatible_api" resolved_path remediation CRAN-only Workspace R remains available fn agent_runtime_status agent_runtime_retry',
  probe: "tryCatch(loadNamespace(name), error = function(error) error)",
  frontend: "AgentRuntimeDiagnostics getAgentRuntimeDiagnostics Dependency details Copy diagnostics installed: required:  >= status: path: Provider adapters: Workspace R remains independent",
  mock: "incompatible_version 1.4.12 1.5.0 CRAN currently provides 1.4.12 aisdk.providers missing /project/renv/library/R-4.6/aarch64-apple-darwin/aisdk",
  transport: 'createTauriAgentRuntimeTransport "agent_runtime_status" "agent_runtime_retry"',
  contractTest: "CRAN currently provides 1.4.12 required:  >= 1.5.0",
  spec: "Issue #94 owns canonical Agent dependency manifests\nIssue #93 owns Workspace R/Ark supervision",
});

if (process.argv.includes("--test")) {
  validateAgentDependencyDiagnostics(fixture());
  for (const [name, mutate] of [
    ["backend classification", (value) => { value.rust = value.rust.replace("incompatible_api", ""); }],
    ["copyable UI", (value) => { value.frontend = value.frontend.replace("Copy diagnostics", ""); }],
    ["CRAN warning", (value) => { value.mock = value.mock.replace("CRAN currently provides 1.4.12", ""); }],
    ["status transport", (value) => { value.transport = value.transport.replace("agent_runtime_status", "missing_status"); }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateAgentDependencyDiagnostics(value), undefined, name);
  }
} else {
  const rust = read("desktop/src-tauri/src/main.rs");
  validateAgentDependencyDiagnostics({
    rust,
    probe: rust.slice(rust.indexOf("fn agent_runtime_probe_expression"), rust.indexOf("fn agent_runtime_status_from_probe")),
    frontend: `${read("desktop/ui/src/app/App.tsx")}\n${read("desktop/ui/src/transport/types.ts")}`,
    mock: read("desktop/ui/src/transport/mock.ts"),
    transport: `${read("desktop/ui/src/transport/tauri.ts")}\n${read("desktop/ui/src/transport/agent-runtime.ts")}\n${read("desktop/ui/src/transport/generated/agent-runtime.ts")}`,
    contractTest: read("desktop/ui/src/app/App.test.tsx"),
    spec: read("docs/plans/implemented-2026-08-21-agent-dependency-diagnostics-fault-isolation-spec.md"),
  });
}

console.log("Agent dependency diagnostics contract passed");
