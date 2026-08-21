import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validateAgentDependencyDiagnostics(value) {
  for (const marker of [
    "struct AgentDependencyStatus",
    "provider_adapters_available",
    "provider_health",
    "dependencies: Vec<AgentDependencyStatus>",
    "__RHO_AGENT_DEP__",
    '"missing"',
    '"incompatible_version"',
    '"namespace_load_failed"',
    '"incompatible_api"',
    "tryCatch(loadNamespace(name)",
    "normalize_capability_model_routes",
    "set_run_trace_sink",
    "create_deepseek",
    "create_nvidia",
    "CRAN-only",
    "REVIEWED_AISDK_REMOTE",
    "REVIEWED_AISDK_PROVIDERS_REMOTE",
    "Workspace R remains available",
  ]) assert.ok(value.rust.includes(marker), `Agent dependency backend lost ${marker}`);
  assert.doesNotMatch(
    value.probe,
    /stop\s*\(/,
    "optional package health must not abort the structured probe",
  );

  for (const marker of [
    "function agentRuntimeSummary",
    "function agentRuntimeDiagnosticsText",
    "function appendAgentRuntimeDiagnostics",
    "function selectedAgentProvider",
    "Agent dependencies need attention",
    "Provider adapters need attention",
    "Copy diagnostics",
    "Resolved path:",
    "CRAN-only",
    "Provider credentials, endpoints, and network are checked separately",
    'scenario === "agent-dependencies"',
    "mockAgentRuntimeFixture",
    "Workspace R remains available",
  ]) assert.ok(value.frontend.includes(marker), `Agent dependency UI/mock lost ${marker}`);
  assert.doesNotMatch(
    value.sendReason,
    /assistant connection is unavailable/i,
    "dependency failure must not be called an Assistant connection failure",
  );
  assert.match(value.sendReason, /provider\?\.kind === "registered"/);
  assert.match(value.sendReason, /requires aisdk\.providers/);
  assert.match(value.sendReason, /Workspace R remains available/);
  assert.match(value.retry, /retry Agent dependency check/);
  assert.match(value.retry, /Workspace R remains available/);
  assert.doesNotMatch(value.retry, /Review model settings and try again/);
  assert.match(value.startup, /const status = await invoke\("workspace_start"\)/);
  assert.match(value.startup, /void invoke\("agent_runtime_retry"\)/);
  assert.doesNotMatch(value.startup, /await invoke\("agent_runtime_retry"\)/);
  assert.match(value.startup, /state\.agentRuntime = agentProbeFailureRuntime\(error, startupView\)/);
  assert.match(value.startup, /Agent dependency check failed; Workspace R remains available/);

  assert.match(value.html, /Retry Agent dependency check/);
  assert.match(value.html, />Retry dependencies</);
  assert.match(value.styles, /\.agent-dependency-diagnostics/);
  assert.match(value.styles, /\.agent-dependency-remediation/);
  assert.match(value.spec, /Only ADI-1 is active/);
  assert.match(value.spec, /Issue #94 owns canonical Agent dependency manifests/);
  assert.match(value.spec, /Issue #93 owns Workspace R\/Ark supervision/);
  assert.match(value.spec, /No CI, remote check, multi-platform/);
}

function fixture() {
  return {
    rust: "struct AgentDependencyStatus\nprovider_adapters_available\nprovider_health\ndependencies: Vec<AgentDependencyStatus>\n__RHO_AGENT_DEP__\n\"missing\"\n\"incompatible_version\"\n\"namespace_load_failed\"\n\"incompatible_api\"\ntryCatch(loadNamespace(name)\nnormalize_capability_model_routes\nset_run_trace_sink\ncreate_deepseek\ncreate_nvidia\nCRAN-only\nREVIEWED_AISDK_REMOTE\nREVIEWED_AISDK_PROVIDERS_REMOTE\nWorkspace R remains available",
    probe: "tryCatch(loadNamespace(name), error = function(error) error)",
    frontend: "function agentRuntimeSummary\nfunction agentRuntimeDiagnosticsText\nfunction appendAgentRuntimeDiagnostics\nfunction selectedAgentProvider\nAgent dependencies need attention\nProvider adapters need attention\nCopy diagnostics\nResolved path:\nCRAN-only\nProvider credentials, endpoints, and network are checked separately\nscenario === \"agent-dependencies\"\nmockAgentRuntimeFixture\nWorkspace R remains available",
    sendReason: 'return agentRuntimeSummary(state.agentRuntime);\nconst provider = selectedAgentProvider();\nif (state.agentRuntime?.provider_adapters_available === false && provider?.kind === "registered") return "The selected Provider requires aisdk.providers; Workspace R remains available.";',
    retry: 'reportUiFailure("retry Agent dependency check", error, "Workspace R remains available.")',
    startup: 'const status = await invoke("workspace_start");\nvoid invoke("agent_runtime_retry").then(() => {}).catch((error) => { state.agentRuntime = agentProbeFailureRuntime(error, startupView); addLog("SYSTEM", "Agent dependency check failed; Workspace R remains available"); });',
    html: '<button title="Retry Agent dependency check">Retry dependencies</button>',
    styles: ".agent-dependency-diagnostics {}\n.agent-dependency-remediation {}",
    spec: "Only ADI-1 is active\nIssue #94 owns canonical Agent dependency manifests\nIssue #93 owns Workspace R/Ark supervision\nNo CI, remote check, multi-platform",
  };
}

if (process.argv.includes("--test")) {
  validateAgentDependencyDiagnostics(fixture());
  for (const [name, mutate] of [
    ["core state", (value) => { value.rust = value.rust.replace('"incompatible_version"', ""); }],
    ["provider split", (value) => { value.rust = value.rust.replace("provider_adapters_available", ""); }],
    ["selected provider admission", (value) => { value.sendReason = value.sendReason.replace('provider?.kind === "registered"', "false"); }],
    ["copy", (value) => { value.frontend = value.frontend.replace("Copy diagnostics", ""); }],
    ["fault isolation", (value) => { value.startup = value.startup.replace('void invoke("agent_runtime_retry")', 'await invoke("agent_runtime_retry")'); }],
    ["provider separation", (value) => { value.frontend = value.frontend.replace("Provider credentials, endpoints, and network are checked separately", ""); }],
    ["scope", (value) => { value.spec = value.spec.replace("Issue #94 owns canonical Agent dependency manifests", ""); }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateAgentDependencyDiagnostics(value), undefined, name);
  }
} else {
  const frontend = read("desktop/dist/app.js");
  const rust = read("desktop/src-tauri/src/main.rs");
  validateAgentDependencyDiagnostics({
    rust,
    probe: rust.slice(rust.indexOf("fn agent_runtime_probe_expression"), rust.indexOf("fn agent_runtime_status_from_probe")),
    frontend,
    sendReason: frontend.slice(frontend.indexOf("function agentSendDisabledReason"), frontend.indexOf("function activeAgentConversations")),
    retry: frontend.slice(frontend.indexOf('$("#agentRuntimeRetryButton").addEventListener'), frontend.indexOf('$("#agentCancelButton").addEventListener')),
    startup: frontend.slice(frontend.indexOf("async function finishWorkbenchStartup"), frontend.indexOf("async function runStartup")),
    html: read("desktop/dist/index.html"),
    styles: read("desktop/dist/styles.css"),
    spec: read("docs/plans/implemented-2026-08-21-agent-dependency-diagnostics-fault-isolation-spec.md"),
  });
}

console.log("Agent dependency diagnostics contract passed");
