import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validateP24RetentionPurgeContract(value) {
  for (const marker of [
    "WorkspacePluginRetentionSweep",
    "WorkspacePluginPurgeDraft",
    "expire_workspace_plugin_tombstones",
    "request_workspace_plugin_purge",
    "complete_workspace_plugin_purge",
    "MAX_RETENTION_BATCH",
    "retention_expiry_purge_and_terminal_tombstone_are_bounded_and_project_scoped",
    "retention_and_purge_persistence_failures_roll_back_and_reopen_retry",
    "concurrent_exact_purge_requests_converge_without_cross_project_takeover",
  ]) assert.ok(value.store.includes(marker), `D3 Store retention truth lost ${marker}`);
  for (const marker of [
    "pub fn purge_exact(",
    "BeforePurgeRename",
    "AfterPurgeRename",
    "MidPurgeDelete",
    "AfterPurgeDelete",
    "PurgeMarker",
    "ensure_purge_marker",
    "validate_bounded_purge_tree",
    "remove_bounded_purge_tree",
    "MAX_PURGE_ENTRIES",
    "purge_interruptions_recover_from_exact_marker_and_ownership",
    "purge_rejects_link_marker_tampering_and_overdeep_partial_tree",
  ]) assert.ok(value.trash.includes(marker), `D3 exact filesystem purge lost ${marker}`);
  for (const marker of [
    "PluginTrashRetentionService",
    "pub fn expire(",
    "pub fn purge_exact_tombstone(",
    ".request_purge(",
    ".purge_exact(",
    ".complete_purge(",
    "service_orders_expiry_filesystem_purge_and_terminal_truth",
    "service_rejects_foreign_project_without_touching_exact_trash",
  ]) assert.ok(value.service.includes(marker), `D3 retention ordering lost ${marker}`);
  for (const marker of [
    'report["retention_expired"] = json!(true)',
    'report["purge_pending_durable"] = json!(true)',
    'report["exact_trash_purged"] = json!(true)',
    'report["purge_tombstone_terminal"] = json!(true)',
    'report["purge_sibling_project_preserved"] = json!(true)',
    'report["purge_replay_idempotent"] = json!(true)',
  ]) assert.ok(value.installed.includes(marker), `installed D3 smoke lost ${marker}`);
  assert.match(value.workspace, /version = "0\.4\.1-dev\.9"/);
  assert.equal(JSON.parse(value.tauri).version, "0.4.1-dev.9");
  assert.match(value.spec, /Activated P2-4D3 contract — 2026-08-21/);
  assert.doesNotMatch(
    value.commands,
    /purge_workspace_plugin|expire_workspace_plugin|rollback_workspace_plugin/,
    "D3 added a user purge, automatic expiry, Update, or Rollback command",
  );
  assert.doesNotMatch(value.frontend, /data-plugin-purge|Purge plugin trash/, "D3 added purge UI");
}

function fixture() {
  return {
    store: "WorkspacePluginRetentionSweep\nWorkspacePluginPurgeDraft\nexpire_workspace_plugin_tombstones\nrequest_workspace_plugin_purge\ncomplete_workspace_plugin_purge\nMAX_RETENTION_BATCH\nretention_expiry_purge_and_terminal_tombstone_are_bounded_and_project_scoped\nretention_and_purge_persistence_failures_roll_back_and_reopen_retry\nconcurrent_exact_purge_requests_converge_without_cross_project_takeover",
    trash: "pub fn purge_exact(\nBeforePurgeRename\nAfterPurgeRename\nMidPurgeDelete\nAfterPurgeDelete\nPurgeMarker\nensure_purge_marker\nvalidate_bounded_purge_tree\nremove_bounded_purge_tree\nMAX_PURGE_ENTRIES\npurge_interruptions_recover_from_exact_marker_and_ownership\npurge_rejects_link_marker_tampering_and_overdeep_partial_tree",
    service: "PluginTrashRetentionService\npub fn expire(\npub fn purge_exact_tombstone(\n.request_purge(\n.purge_exact(\n.complete_purge(\nservice_orders_expiry_filesystem_purge_and_terminal_truth\nservice_rejects_foreign_project_without_touching_exact_trash",
    installed: 'report["retention_expired"] = json!(true)\nreport["purge_pending_durable"] = json!(true)\nreport["exact_trash_purged"] = json!(true)\nreport["purge_tombstone_terminal"] = json!(true)\nreport["purge_sibling_project_preserved"] = json!(true)\nreport["purge_replay_idempotent"] = json!(true)',
    workspace: 'version = "0.4.1-dev.9"',
    tauri: '{"version":"0.4.1-dev.9"}',
    spec: "Activated P2-4D3 contract — 2026-08-21",
    commands: "list_workspace_plugins",
    frontend: "Workspace Plugins",
  };
}

if (process.argv.includes("--test")) {
  validateP24RetentionPurgeContract(fixture());
  for (const [name, mutate] of [
    ["pending truth", (value) => { value.store = value.store.replace("request_workspace_plugin_purge", ""); }],
    ["marker", (value) => { value.trash = value.trash.replace("PurgeMarker", ""); }],
    ["mid delete recovery", (value) => { value.trash = value.trash.replace("MidPurgeDelete", ""); }],
    ["ordering", (value) => { value.service = value.service.replace(".complete_purge(", ""); }],
    ["sibling isolation", (value) => { value.installed = value.installed.replace('report["purge_sibling_project_preserved"] = json!(true)', ""); }],
    ["version", (value) => { value.workspace = 'version = "0.4.1-dev.8"'; }],
    ["purge UI", (value) => { value.frontend += "\ndata-plugin-purge"; }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateP24RetentionPurgeContract(value), undefined, name);
  }
} else {
  validateP24RetentionPurgeContract({
    store: read("crates/rho-store/src/plugin_lifecycle.rs"),
    trash: read("crates/rho-server/src/plugin_package_trash.rs"),
    service: read("crates/rho-server/src/plugin_retention.rs"),
    installed: read("desktop/src-tauri/src/main.rs"),
    workspace: read("Cargo.toml"),
    tauri: read("desktop/src-tauri/tauri.conf.json"),
    spec: read("docs/plans/active-2026-08-20-p2-4-plugin-lifecycle-recovery-upgrade-spec.md"),
    commands: read("desktop/src-tauri/src/commands/plugins.rs"),
    frontend: read("desktop/dist/app.js"),
  });
}

console.log("extension P2-4 retention purge contract passed");
