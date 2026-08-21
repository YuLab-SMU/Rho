import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

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
  ]) assert.ok(value.main.includes(marker), `desktop restart wiring lost ${marker}`);
  const startup = value.main.slice(
    value.main.indexOf("async fn start_workspace"),
    value.main.indexOf("async fn finalize_workspace_start"),
  );
  assert.ok(
    startup.indexOf("recover_pending_plugin_permission_requests") < startup.indexOf("reconcile_project"),
    "permission recovery must precede plugin reconstruction",
  );
  assert.doesNotMatch(
    value.commands,
    /rollback_workspace_plugin/,
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
  assert.match(value.spec, /P2-4B3 \/ P2-4B local checkpoint — 2026-08-20/);
}

function fixture() {
  return {
    desktop: "pub(crate) struct WorkspacePluginReconciliationReport\nWorkspacePluginReconciliationEntry\nMAX_PLUGIN_RECONCILIATION_ENTRIES\npub truncated: bool\nreactivated\nentries\npub(crate) struct PluginPermissionDecisionInput\nreconcile_project\nreconcile_discovered_plugin\nprepare_recovery_enable_transition\npersist_missing_plugin_block\nmissing_workspace_plugin_view\nbroker_restart_reconciled\nrequest_event_type: \"recovery\"\nfresh_permission_review_required\nrestart_reconstructs_exact_durable_enable_with_fresh_generation_and_host\nrestart_recovers_nonterminal_post_publication_enable_without_reusing_generation\nrestart_reuses_only_valid_project_grants_and_never_reuses_live_handles\nrestart_reconciliation_isolates_two_projects_across_a_b_a\none_invalid_plugin_does_not_block_exact_sibling_reactivation\nrestart_invalid_discovery_root_blocks_all_durable_enablement\nrestart_corrupt_cache_blocks_without_loading_mutable_source",
    main: "async fn start_workspace\nrecover_pending_plugin_permission_requests\nreconcile_project\nasync fn finalize_workspace_start\n\"trigger\": \"workspace_start\"\n\"project_switched\"\n\"project_switch_restored\"\n\"workspace_plugin_reconciliation\"\nworkspace_plugin_runtime_context",
    commands: "request_workspace_plugin_enable",
    store: "pub request_event_type: String\n\"user_requested\" | \"recovery\"\nevent_type: &draft.request_event_type",
    installed: '"restart_reactivated": true\n"restart_generation": 2\n"restart_authority_fresh": true\n"changed_package_update_pending": true',
    spec: "P2-4B3 / P2-4B local checkpoint — 2026-08-20",
  };
}

if (process.argv.includes("--test")) {
  validateP24RestartContract(fixture());
  for (const [name, mutate] of [
    ["fresh generation", (value) => { value.desktop = value.desktop.replace("without_reusing_generation", ""); }],
    ["nonblocking wiring", (value) => { value.main = value.main.replace('"project_switched"', ""); }],
    ["permission order", (value) => { value.main = value.main.replace("recover_pending_plugin_permission_requests\nreconcile_project", "reconcile_project\nrecover_pending_plugin_permission_requests"); }],
    ["recovery audit", (value) => { value.store = value.store.replace('"user_requested" | "recovery"', '"user_requested"'); }],
    ["later command", (value) => { value.commands += "\nrollback_workspace_plugin"; }],
    ["installed", (value) => { value.installed = value.installed.replace('"restart_reactivated": true', ""); }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateP24RestartContract(value), undefined, name);
  }
} else {
  validateP24RestartContract({
    desktop: read("desktop/src-tauri/src/workspace_plugins.rs"),
    main: read("desktop/src-tauri/src/main.rs"),
    commands: read("desktop/src-tauri/src/commands/plugins.rs"),
    store: read("crates/rho-store/src/plugin_lifecycle.rs"),
    installed: read("desktop/src-tauri/src/main.rs"),
    spec: read("docs/plans/active-2026-08-20-p2-4-plugin-lifecycle-recovery-upgrade-spec.md"),
  });
}

console.log("extension P2-4 restart reconstruction contract passed");
