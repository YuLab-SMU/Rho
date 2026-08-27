import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

function readRustTree(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const entryPath = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return [readRustTree(entryPath)];
      return entry.isFile() && entry.name.endsWith(".rs") ? [read(entryPath)] : [];
    })
    .join("\n");
}

export function validateP24RestartContract(value) {
  for (const marker of [
    "WorkspacePluginReconciliationReport",
    "WorkspacePluginReconciliationEntry",
    "MAX_PLUGIN_RECONCILIATION_ENTRIES",
    "pub truncated: bool",
    "reconcile_project",
    "reconcile_discovered_plugin",
    "prepare_recovery_enable_transition",
    "persist_missing_plugin_block",
    "missing_workspace_plugin_view",
    "PluginPackageCache::new(&context.app_data_dir)",
    ".load_exact(&context.project_root",
    "broker_restart_reconciled",
    'request_event_type: "recovery"',
    "fresh_permission_review_required",
    "restart_reconstructs_exact_durable_enable_with_fresh_generation_and_host",
    "restart_recovers_nonterminal_post_publication_enable_without_reusing_generation",
    "restart_reuses_only_valid_project_grants_and_never_reuses_live_handles",
    "restart_reconciliation_isolates_two_projects_across_a_b_a",
    "one_invalid_plugin_does_not_block_exact_sibling_reactivation",
    "restart_invalid_discovery_root_blocks_all_durable_enablement",
    "restart_corrupt_cache_blocks_without_loading_mutable_source",
  ]) assert.ok(value.desktop.includes(marker), `restart reconstruction lost ${marker}`);
  assert.doesNotMatch(
    value.desktop.slice(
      value.desktop.indexOf("pub(crate) struct WorkspacePluginReconciliationReport"),
      value.desktop.indexOf("pub(crate) struct PluginPermissionDecisionInput"),
    ),
    /handle|credential|payload|full_path|wasm_memory/i,
    "restart report exposed live authority or sensitive payload fields",
  );

  for (const marker of [
    '"trigger": "workspace_start"',
    '"project_switched"',
    '"project_switch_restored"',
    '"workspace_plugin_reconciliation"',
    "workspace_plugin_runtime_context",
  ]) assert.ok(value.wiring.includes(marker), `desktop restart wiring lost ${marker}`);
  const recovery = value.wiring.slice(
    value.wiring.indexOf("async fn recover_workspace_store"),
    value.wiring.indexOf("pub(crate) async fn teardown_workspace_plugins_for_boundary"),
  );
  assert.ok(
    recovery.includes("recover_pending_plugin_permission_requests"),
    "store recovery must close pending plugin permission requests",
  );
  const startup = value.wiring.slice(
    value.wiring.indexOf("pub(crate) async fn start_workspace"),
    value.wiring.indexOf("pub(crate) async fn finalize_workspace_start"),
  );
  const storeRecovery = startup.indexOf("recover_workspace_store");
  const pluginReconciliation = startup.indexOf("workspace_plugins::reconcile_plugin_project");
  assert.ok(
    storeRecovery >= 0 && pluginReconciliation >= 0 && storeRecovery < pluginReconciliation,
    "permission recovery must precede plugin reconstruction",
  );
  assert.doesNotMatch(
    value.commands,
    /\binstall_workspace_plugin\b/,
    "B3 prematurely added a later lifecycle command",
  );
  for (const marker of [
    "pub request_event_type: String",
    '"user_requested" | "recovery"',
    "event_type: &draft.request_event_type",
  ]) assert.ok(value.store.includes(marker), `lifecycle recovery audit lost ${marker}`);
  for (const marker of [
    '"restart_reactivated": true',
    '"restart_generation": 2',
    '"restart_authority_fresh": true',
    '"changed_package_update_pending": true',
  ]) assert.ok(value.installed.includes(marker), `installed B3 smoke lost ${marker}`);
}

function fixture() {
  return {
    desktop: "pub(crate) struct WorkspacePluginReconciliationReport\nWorkspacePluginReconciliationEntry\nMAX_PLUGIN_RECONCILIATION_ENTRIES\npub truncated: bool\nreactivated\nentries\npub(crate) struct PluginPermissionDecisionInput\nreconcile_project\nreconcile_discovered_plugin\nprepare_recovery_enable_transition\npersist_missing_plugin_block\nmissing_workspace_plugin_view\nPluginPackageCache::new(&context.app_data_dir)\n.load_exact(&context.project_root\nbroker_restart_reconciled\nrequest_event_type: \"recovery\"\nfresh_permission_review_required\nrestart_reconstructs_exact_durable_enable_with_fresh_generation_and_host\nrestart_recovers_nonterminal_post_publication_enable_without_reusing_generation\nrestart_reuses_only_valid_project_grants_and_never_reuses_live_handles\nrestart_reconciliation_isolates_two_projects_across_a_b_a\none_invalid_plugin_does_not_block_exact_sibling_reactivation\nrestart_invalid_discovery_root_blocks_all_durable_enablement\nrestart_corrupt_cache_blocks_without_loading_mutable_source",
    wiring: "async fn recover_workspace_store\nrecover_pending_plugin_permission_requests\npub(crate) async fn teardown_workspace_plugins_for_boundary\npub(crate) async fn start_workspace\nrecover_workspace_store\nworkspace_plugins::reconcile_plugin_project\npub(crate) async fn finalize_workspace_start\n\"trigger\": \"workspace_start\"\n\"project_switched\"\n\"project_switch_restored\"\n\"workspace_plugin_reconciliation\"\nworkspace_plugin_runtime_context",
    commands: "request_workspace_plugin_enable",
    store: "pub request_event_type: String\n\"user_requested\" | \"recovery\"\nevent_type: &draft.request_event_type",
    installed: '"restart_reactivated": true\n"restart_generation": 2\n"restart_authority_fresh": true\n"changed_package_update_pending": true',
  };
}

if (process.argv.includes("--test")) {
  validateP24RestartContract(fixture());
  for (const [name, mutate] of [
    ["fresh generation", (value) => { value.desktop = value.desktop.replace("without_reusing_generation", ""); }],
    ["durable cache", (value) => { value.desktop = value.desktop.replace(".load_exact(&context.project_root", ""); }],
    ["nonblocking wiring", (value) => { value.wiring = value.wiring.replace('"project_switched"', ""); }],
    ["permission recovery", (value) => { value.wiring = value.wiring.replace("recover_pending_plugin_permission_requests", ""); }],
    ["permission order", (value) => { value.wiring = value.wiring.replace("recover_workspace_store\nworkspace_plugins::reconcile_plugin_project", "workspace_plugins::reconcile_plugin_project\nrecover_workspace_store"); }],
    ["recovery audit", (value) => { value.store = value.store.replace('"user_requested" | "recovery"', '"user_requested"'); }],
    ["later command", (value) => { value.commands += "\ninstall_workspace_plugin"; }],
    ["installed", (value) => { value.installed = value.installed.replace('"restart_reactivated": true', ""); }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateP24RestartContract(value), undefined, name);
  }
} else {
  validateP24RestartContract({
    desktop: readRustTree("desktop/src-tauri/src/workspace_plugins"),
    wiring: [
      read("desktop/src-tauri/src/workspace_lifecycle.rs"),
      read("desktop/src-tauri/src/project_transition.rs"),
      read("desktop/src-tauri/src/internal_extensions.rs"),
    ].join("\n"),
    commands: read("desktop/src-tauri/src/commands/plugins.rs"),
    store: read("crates/rho-store/src/plugin_lifecycle.rs"),
    installed: read("desktop/src-tauri/src/smoke/plugin_host.rs"),
  });
}

console.log("extension P2-4 restart reconstruction contract passed");
