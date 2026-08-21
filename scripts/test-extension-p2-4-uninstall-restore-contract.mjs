import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validateP24UninstallRestoreContract(value) {
  for (const marker of [
    "WorkspacePluginUninstallCompletion",
    "WorkspacePluginRestoreCompletion",
    "complete_workspace_plugin_uninstall",
    "complete_workspace_plugin_restore",
    "TransactionBehavior::Immediate",
    "package_moved",
    "uninstall_completion_failure_rolls_back_tombstone_and_terminal_state",
    "restore_completion_failure_rolls_back_tombstone_and_state_then_retries",
    "uninstall_completion_and_restore_are_atomic_idempotent_and_reopen_safe",
  ]) assert.ok(value.store.includes(marker), `atomic Uninstall/Restore truth lost ${marker}`);
  for (const marker of [
    "WorkspacePluginUninstallInput",
    "WorkspacePluginRestoreInput",
    "input.confirmed",
    "self.disable(context",
    '"plugin_uninstalled"',
    "PluginPackageTrash::new()",
    ".move_exact(",
    '"package_moved"',
    ".complete_uninstall(",
    ".restore_exact(",
    ".complete_restore(",
    "trusted_uninstall_revokes_exact_authority_and_restore_returns_disabled",
    "uninstall_confirmation_and_restore_are_stale_and_project_scoped",
  ]) assert.ok(value.desktop.includes(marker), `trusted D2 workflow lost ${marker}`);
  for (const marker of [
    "pub(crate) async fn uninstall_workspace_plugin",
    "pub(crate) async fn restore_workspace_plugin",
    "persist_plugin_project_change",
    "project_transition_gate.lock().await",
    "save_identity",
  ]) assert.ok(value.commands.includes(marker), `D2 command/revision wiring lost ${marker}`);
  for (const marker of [
    'command === "uninstall_workspace_plugin"',
    'command === "restore_workspace_plugin"',
    "reviewWorkspacePluginUninstall(pluginId)",
    "confirmWorkspacePluginUninstall()",
    "restoreWorkspacePlugin(tombstoneId)",
    "data-plugin-uninstall",
    "data-plugin-restore",
    "recoverable Rho trash",
  ]) assert.ok(value.frontend.includes(marker), `D2 UI/mock lost ${marker}`);
  for (const marker of [
    'id="pluginUninstallView"',
    'id="pluginUninstallIdentity"',
    'id="pluginUninstallConfirm"',
    "It will not permanently delete it",
  ]) assert.ok(value.html.includes(marker), `trusted confirmation surface lost ${marker}`);
  assert.match(value.workspace, /version = "0\.4\.1-dev\.11"/);
  assert.equal(JSON.parse(value.tauri).version, "0.4.1-dev.11");
  assert.equal(JSON.parse(value.packageJson).version, "0.4.1-dev.11");
  assert.match(value.news, /## 0\.4\.1-dev\.8[\s\S]*Workspace-plugin recoverable Uninstall/);
  for (const marker of [
    'report["recoverable_uninstall"] = json!(true)',
    'report["uninstall_tombstone_atomic"] = json!(true)',
    'report["uninstall_package_in_trash"] = json!(true)',
    'report["restore_disabled_no_authority"] = json!(true)',
  ]) assert.ok(value.installed.includes(marker), `installed D2 smoke lost ${marker}`);
  assert.match(value.spec, /P2-4D2[\s\S]*trusted Uninstall\/Restore commands/);
  assert.doesNotMatch(
    value.commands,
    /\binstall_workspace_plugin\b|purge_workspace_plugin/,
    "D2 prematurely added Update, Rollback, or permanent purge",
  );
}

function fixture() {
  return {
    store: "WorkspacePluginUninstallCompletion\nWorkspacePluginRestoreCompletion\ncomplete_workspace_plugin_uninstall\ncomplete_workspace_plugin_restore\nTransactionBehavior::Immediate\npackage_moved\nuninstall_completion_failure_rolls_back_tombstone_and_terminal_state\nrestore_completion_failure_rolls_back_tombstone_and_state_then_retries\nuninstall_completion_and_restore_are_atomic_idempotent_and_reopen_safe",
    desktop: "WorkspacePluginUninstallInput\nWorkspacePluginRestoreInput\ninput.confirmed\nself.disable(context\n\"plugin_uninstalled\"\nPluginPackageTrash::new()\n.move_exact(\n\"package_moved\"\n.complete_uninstall(\n.restore_exact(\n.complete_restore(\ntrusted_uninstall_revokes_exact_authority_and_restore_returns_disabled\nuninstall_confirmation_and_restore_are_stale_and_project_scoped",
    commands: "pub(crate) async fn uninstall_workspace_plugin\npub(crate) async fn restore_workspace_plugin\npersist_plugin_project_change\nproject_transition_gate.lock().await\nsave_identity",
    frontend: "command === \"uninstall_workspace_plugin\"\ncommand === \"restore_workspace_plugin\"\nreviewWorkspacePluginUninstall(pluginId)\nconfirmWorkspacePluginUninstall()\nrestoreWorkspacePlugin(tombstoneId)\ndata-plugin-uninstall\ndata-plugin-restore\nrecoverable Rho trash",
    html: 'id="pluginUninstallView"\nid="pluginUninstallIdentity"\nid="pluginUninstallConfirm"\nIt will not permanently delete it',
    workspace: 'version = "0.4.1-dev.11"',
    tauri: '{"version":"0.4.1-dev.11"}',
    packageJson: '{"version":"0.4.1-dev.11"}',
    news: "## 0.4.1-dev.8\n### Workspace-plugin recoverable Uninstall",
    installed: 'report["recoverable_uninstall"] = json!(true)\nreport["uninstall_tombstone_atomic"] = json!(true)\nreport["uninstall_package_in_trash"] = json!(true)\nreport["restore_disabled_no_authority"] = json!(true)',
    spec: "P2-4D2 — trusted Uninstall/Restore commands",
  };
}

if (process.argv.includes("--test")) {
  validateP24UninstallRestoreContract(fixture());
  for (const [name, mutate] of [
    ["atomic terminal", (value) => { value.store = value.store.replace("TransactionBehavior::Immediate", ""); }],
    ["confirmation", (value) => { value.desktop = value.desktop.replace("input.confirmed", ""); }],
    ["trash move", (value) => { value.desktop = value.desktop.replace(".move_exact(", ""); }],
    ["restore disabled", (value) => { value.installed = value.installed.replace('report["restore_disabled_no_authority"] = json!(true)', ""); }],
    ["mock", (value) => { value.frontend = value.frontend.replace('command === "restore_workspace_plugin"', ""); }],
    ["version", (value) => { value.workspace = 'version = "0.4.1-dev.10"'; }],
    ["premature purge", (value) => { value.commands += "\npurge_workspace_plugin"; }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateP24UninstallRestoreContract(value), undefined, name);
  }
} else {
  validateP24UninstallRestoreContract({
    store: read("crates/rho-store/src/plugin_lifecycle.rs"),
    desktop: read("desktop/src-tauri/src/workspace_plugins.rs"),
    commands: read("desktop/src-tauri/src/commands/plugins.rs"),
    frontend: read("desktop/dist/app.js"),
    html: read("desktop/dist/index.html"),
    workspace: read("Cargo.toml"),
    tauri: read("desktop/src-tauri/tauri.conf.json"),
    packageJson: read("desktop/package.json"),
    news: read("NEWS.md"),
    installed: read("desktop/src-tauri/src/main.rs"),
    spec: read("docs/plans/implemented-2026-08-20-p2-4-plugin-lifecycle-recovery-upgrade-spec.md"),
  });
}

console.log("extension P2-4 Uninstall and Restore contract passed");
