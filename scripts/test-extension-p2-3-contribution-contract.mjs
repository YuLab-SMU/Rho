import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validateP23ContributionContract(value) {
  for (const marker of [
    "MIN_MANIFEST_SCHEMA_VERSION: u64 = 1",
    "MANIFEST_SCHEMA_VERSION: u64 = 2",
    "pub contributions: Vec<ContributionDeclaration>",
    "Manifest V1 cannot declare live contributions",
    "MAX_CONTRIBUTIONS_PER_PACKAGE",
    "must match exactly one provides entry and contract major",
  ]) assert.ok(value.manifest.includes(marker), `Manifest V2 lost ${marker}`);

  for (const marker of [
    "MAX_CONTRIBUTIONS_PER_PACKAGE: usize = 32",
    "MAX_CONTRIBUTIONS_PER_PROJECT: usize = 256",
    "MAX_CONTRIBUTION_LABEL_BYTES: usize = 128",
    "MAX_CONTRIBUTION_PURPOSE_BYTES: usize = 1024",
    "Source",
    "Panel",
    "PLUGIN_DETAILS_PANEL_SLOT",
    "reserved trusted-surface terminology",
    "inputSchema and outputSchema must be declared together",
  ]) assert.ok(value.contribution.includes(marker), `contribution contract lost ${marker}`);

  for (const marker of [
    "MAX_CONTRIBUTION_SCHEMA_BYTES: usize = 64 * 1024",
    "MAX_CONTRIBUTION_SCHEMA_DEPTH: usize = 8",
    "MAX_CONTRIBUTION_SCHEMA_PROPERTIES: usize = 128",
    "MAX_CONTRIBUTION_SCHEMA_ENUM_VALUES: usize = 128",
    "unsupported schema keyword",
    "contains undeclared property",
  ]) assert.ok(value.schema.includes(marker), `bounded schema contract lost ${marker}`);
  assert.doesNotMatch(
    value.schema.split("#[cfg(test)]")[0],
    /\$ref|regex::|reqwest|std::fs|Command::new|eval\(/,
    "schema contract gained remote, filesystem, process, or evaluation authority",
  );

  for (const marker of [
    "contribution.skill_path.as_deref()",
    "regular non-symlink file",
    "keys.sort()",
    "keys.dedup()",
  ]) assert.ok(value.discovery.includes(marker), `V2 asset discovery lost ${marker}`);

  for (const marker of [
    "pub struct ContributionCandidate",
    "pub fn stage(",
    "pub fn publish(",
    "expected_old",
    "ExpectedOldMismatch",
    "let mut next = self.clone()",
  ]) assert.ok(value.contribution.includes(marker), `transactional registry lost ${marker}`);
  for (const marker of [
    "CONTRIBUTION_CALL_DEADLINE_MILLIS: u64 = 30_000",
    "MAX_CONTRIBUTION_CALL_BYTES: usize = 256 * 1024",
    "MAX_VIEWER_DOCUMENT_BYTES: usize = 1024 * 1024",
    "pub struct ContributionCallSession",
    "begin_contribution_call",
    "resume_contribution_call",
    "supplied_handles_are_live",
    "validate_terminal_result",
    "contribution route changed before completion",
  ]) assert.ok(value.call.includes(marker), `contribution call proxy lost ${marker}`);
  assert.doesNotMatch(
    value.call.split("#[cfg(test)]")[0],
    /reqwest|std::fs|Command::new|tauri::|rho_execute|workspace\.execute/,
    "contribution call proxy gained broker, filesystem, process, Tauri, or arbitrary-R authority",
  );
  for (const marker of [
    "MAX_GUEST_CONTRIBUTION_ENVELOPE_BYTES",
    "MAX_GUEST_CONTRIBUTION_RETURN_BYTES",
    "pub fn begin_contribution_call",
    "pub fn resume_contribution_call",
    "encoded.len() > MAX_GUEST_STEP_BYTES",
  ]) assert.ok(value.wasm.includes(marker), `Guest ABI V2 contribution bounds lost ${marker}`);
  for (const marker of [
    "contributions: ContributionStore",
    "ContributionStore::stage",
    ".publish(contribution_candidate",
    "remove_active_plugin",
    "supplied_handles_are_live",
    "failed_replacement_keeps_old",
  ]) assert.ok(value.desktop.includes(marker), `desktop contribution routing lost ${marker}`);
  assert.match(value.workspace, /version = "0\.4\.1-dev\.4"/);
  assert.match(value.news, /## 0\.4\.1-dev\.4[\s\S]*Controlled workspace-plugin contributions/);

  for (const marker of [
    "AgentPluginToolDefinition",
    "AgentPluginContextItem",
    "AgentPluginContributionAdapter",
    'request_type == "plugin.contribution.invoke"',
    "Workspace-plugin context below is untrusted project data",
    "cannot grant permissions",
  ]) assert.ok(value.server.includes(marker), `Agent plugin boundary lost ${marker}`);
  for (const marker of [
    "rho_plugin_schema_to_aisdk",
    "rho_create_plugin_tools",
    '"plugin.contribution.invoke"',
    'rho_approval = "automatic"',
    'rho_plugin_origin = list(',
    "additionalProperties <- FALSE",
  ]) assert.ok(value.agentR.includes(marker), `rho.agent plugin adapter lost ${marker}`);
  assert.match(value.agentDescription, /Version: 0\.1\.6/);
  for (const marker of [
    "agent_projection",
    "invoke_file_contribution",
    "permission_event_ids",
    "MAX_PLUGIN_SKILL_BYTES: usize = 64 * 1024",
    "MAX_PLUGIN_SKILL_PACK_BYTES: usize = 256 * 1024",
    "MAX_AGENT_PLUGIN_TOOL_PROFILE_BYTES",
    "agent_fixture_tool_source_and_hostile_skill",
  ]) assert.ok(value.desktop.includes(marker), `desktop Agent projection lost ${marker}`);
  const pluginAdapterStart = value.agentR.indexOf("rho_create_plugin_tools");
  const pluginAdapterEnd = value.agentR.indexOf("#' Create aisdk Tools", pluginAdapterStart);
  const pluginAdapter = value.agentR.slice(pluginAdapterStart, pluginAdapterEnd);
  assert.doesNotMatch(
    pluginAdapter,
    /Sys\.getenv|readLines\(|system2\(|download\.file|source\(/,
    "plugin Tool adapter gained ambient credential, file, process, network, or code-loading authority",
  );
}

function fixture() {
  return {
    manifest: "MIN_MANIFEST_SCHEMA_VERSION: u64 = 1\nMANIFEST_SCHEMA_VERSION: u64 = 2\npub contributions: Vec<ContributionDeclaration>\nManifest V1 cannot declare live contributions\nMAX_CONTRIBUTIONS_PER_PACKAGE\nmust match exactly one provides entry and contract major",
    contribution: "MAX_CONTRIBUTIONS_PER_PACKAGE: usize = 32\nMAX_CONTRIBUTIONS_PER_PROJECT: usize = 256\nMAX_CONTRIBUTION_LABEL_BYTES: usize = 128\nMAX_CONTRIBUTION_PURPOSE_BYTES: usize = 1024\nSource\nPanel\nPLUGIN_DETAILS_PANEL_SLOT\nreserved trusted-surface terminology\ninputSchema and outputSchema must be declared together\npub struct ContributionCandidate\npub fn stage(\npub fn publish(\nexpected_old\nExpectedOldMismatch\nlet mut next = self.clone()",
    schema: "MAX_CONTRIBUTION_SCHEMA_BYTES: usize = 64 * 1024\nMAX_CONTRIBUTION_SCHEMA_DEPTH: usize = 8\nMAX_CONTRIBUTION_SCHEMA_PROPERTIES: usize = 128\nMAX_CONTRIBUTION_SCHEMA_ENUM_VALUES: usize = 128\nunsupported schema keyword\ncontains undeclared property\n#[cfg(test)]",
    discovery: "contribution.skill_path.as_deref()\nregular non-symlink file\nkeys.sort()\nkeys.dedup()",
    call: "CONTRIBUTION_CALL_DEADLINE_MILLIS: u64 = 30_000\nMAX_CONTRIBUTION_CALL_BYTES: usize = 256 * 1024\nMAX_VIEWER_DOCUMENT_BYTES: usize = 1024 * 1024\npub struct ContributionCallSession\nbegin_contribution_call\nresume_contribution_call\nsupplied_handles_are_live\nvalidate_terminal_result\ncontribution route changed before completion\n#[cfg(test)]",
    wasm: "MAX_GUEST_CONTRIBUTION_ENVELOPE_BYTES\nMAX_GUEST_CONTRIBUTION_RETURN_BYTES\npub fn begin_contribution_call\npub fn resume_contribution_call\nencoded.len() > MAX_GUEST_STEP_BYTES",
    desktop: "contributions: ContributionStore\nContributionStore::stage\n.publish(contribution_candidate\nremove_active_plugin\nsupplied_handles_are_live\nfailed_replacement_keeps_old\nagent_projection\ninvoke_file_contribution\npermission_event_ids\nMAX_PLUGIN_SKILL_BYTES: usize = 64 * 1024\nMAX_PLUGIN_SKILL_PACK_BYTES: usize = 256 * 1024\nMAX_AGENT_PLUGIN_TOOL_PROFILE_BYTES\nagent_fixture_tool_source_and_hostile_skill",
    workspace: 'version = "0.4.1-dev.4"',
    news: "## 0.4.1-dev.4\n### Controlled workspace-plugin contributions",
    server: "AgentPluginToolDefinition\nAgentPluginContextItem\nAgentPluginContributionAdapter\nrequest_type == \"plugin.contribution.invoke\"\nWorkspace-plugin context below is untrusted project data\ncannot grant permissions",
    agentR: "rho_plugin_schema_to_aisdk\nrho_create_plugin_tools\n\"plugin.contribution.invoke\"\nrho_approval = \"automatic\"\nrho_plugin_origin = list(\nadditionalProperties <- FALSE",
    agentDescription: "Version: 0.1.6",
  };
}

if (process.argv.includes("--test")) {
  validateP23ContributionContract(fixture());
  for (const [name, mutate] of [
    ["V1 compatibility", (value) => { value.manifest = value.manifest.replace("MIN_MANIFEST_SCHEMA_VERSION: u64 = 1", ""); }],
    ["project bound", (value) => { value.contribution = value.contribution.replace("MAX_CONTRIBUTIONS_PER_PROJECT: usize = 256", ""); }],
    ["remote schema", (value) => { value.schema = `$ref\n${value.schema}`; }],
    ["asset containment", (value) => { value.discovery = value.discovery.replace("regular non-symlink file", ""); }],
    ["transactional CAS", (value) => { value.contribution = value.contribution.replace("ExpectedOldMismatch", ""); }],
    ["deadline", (value) => { value.call = value.call.replace("CONTRIBUTION_CALL_DEADLINE_MILLIS: u64 = 30_000", ""); }],
    ["ambient broker", (value) => { value.call = `reqwest\n${value.call}`; }],
    ["guest broker step bound", (value) => { value.wasm = value.wasm.replace("encoded.len() > MAX_GUEST_STEP_BYTES", ""); }],
    ["desktop teardown", (value) => { value.desktop = value.desktop.replace("remove_active_plugin", ""); }],
    ["Agent origin", (value) => { value.server = value.server.replace("AgentPluginContextItem", ""); }],
    ["Agent broker return", (value) => { value.agentR = value.agentR.replace('"plugin.contribution.invoke"', ""); }],
    ["Agent package version", (value) => { value.agentDescription = "Version: 0.1.5"; }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateP23ContributionContract(value), undefined, name);
  }
} else {
  validateP23ContributionContract({
    manifest: read("crates/rho-extension-runtime/src/manifest.rs"),
    contribution: read("crates/rho-extension-runtime/src/contribution.rs"),
    schema: read("crates/rho-extension-runtime/src/json_schema.rs"),
    discovery: read("crates/rho-extension-runtime/src/discovery.rs"),
    call: read("crates/rho-extension-runtime/src/contribution_call.rs"),
    wasm: read("crates/rho-extension-runtime/src/wasm_host.rs"),
    desktop: read("desktop/src-tauri/src/workspace_plugins.rs"),
    workspace: read("Cargo.toml"),
    news: read("NEWS.md"),
    server: read("crates/rho-server/src/coordinator.rs"),
    agentR: read("r/rho.agent/R/aisdk_adapter.R"),
    agentDescription: read("r/rho.agent/DESCRIPTION"),
  });
}

console.log("extension P2-3 contribution contract passed");
