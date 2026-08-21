import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validateP24RecoveryCloseout(value) {
  for (const marker of [
    "pub recovered_uninstalls: usize",
    "pub recovered_purges: usize",
    "pub recovered_replacements: usize",
    "pub recovery_required: usize",
    "pub project_files_changed: bool",
    "recover_project_plugin_files",
    "tombstone.recovery.",
    "broker_restart_reconciled",
    "interrupted_replacement",
    "reconciliation_finishes_incomplete_uninstall_and_moves_files_once",
    "reconciliation_replays_purge_pending_and_preserves_terminal_tombstone",
    "reconciliation_closes_interrupted_replacement_and_reconstructs_accepted_old_cache",
    "unprovable_dual_ownership_projects_recovery_required_without_action",
  ]) assert.ok(value.runtime.includes(marker), `F recovery closeout lost ${marker}`);
  for (const marker of [
    "record_workspace_plugin_recovery_required",
    'observed_state = \'blocked\'',
    '"recovery_required":true',
    "recovery_required_is_exact_idempotent_and_event_atomic",
  ]) assert.ok(value.store.includes(marker), `F durable recovery-required truth lost ${marker}`);
  for (const marker of [
    "plugin_reconciliation.project_files_changed",
    "post_revision_reconciliation",
    "report.project_files_changed",
    "post_revision_report",
    "broker.project_changed()",
    "save_identity",
  ]) assert.ok(value.main.includes(marker), `F once-only project revision wiring lost ${marker}`);
  for (const marker of [
    "pub(crate) async fn get_workspace_plugin_transition",
    "PluginLifecycleQueryService",
    ".get_transition(",
  ]) assert.ok(value.commands.includes(marker), `F read-only transition command lost ${marker}`);
  for (const marker of [
    'command === "get_workspace_plugin_transition"',
    'recovery_required: "Recovery required"',
    'status === "recovery_required"',
    "no completion is claimed",
  ]) assert.ok(value.frontend.includes(marker), `F recovery UI/mock lost ${marker}`);
  assert.match(value.workspace, /version = "0\.4\.1-dev\.11"/);
  assert.equal(JSON.parse(value.tauri).version, "0.4.1-dev.11");
  assert.equal(JSON.parse(value.packageJson).version, "0.4.1-dev.11");
  assert.match(value.news, /## 0\.4\.1-dev\.11[\s\S]*Workspace-plugin crash-point recovery truth/);
  for (const marker of [
    'report["recovery_incomplete_uninstall"] = json!(true)',
    'report["recovery_project_revision_once"] = json!(true)',
    'report["recovery_purge_pending"] = json!(true)',
  ]) assert.ok(value.installed.includes(marker), `installed F smoke lost ${marker}`);
  assert.match(value.spec, /Activated P2-4F contract — 2026-08-21/);
  assert.doesNotMatch(value.commands, /\binstall_workspace_plugin\b/, "F added install authority");
}

function fixture() {
  return {
    runtime: "pub recovered_uninstalls: usize\npub recovered_purges: usize\npub recovered_replacements: usize\npub recovery_required: usize\npub project_files_changed: bool\nrecover_project_plugin_files\ntombstone.recovery.\nbroker_restart_reconciled\ninterrupted_replacement\nreconciliation_finishes_incomplete_uninstall_and_moves_files_once\nreconciliation_replays_purge_pending_and_preserves_terminal_tombstone\nreconciliation_closes_interrupted_replacement_and_reconstructs_accepted_old_cache\nunprovable_dual_ownership_projects_recovery_required_without_action",
    store: "record_workspace_plugin_recovery_required\nobserved_state = 'blocked'\n\"recovery_required\":true\nrecovery_required_is_exact_idempotent_and_event_atomic",
    main: "plugin_reconciliation.project_files_changed\npost_revision_reconciliation\nreport.project_files_changed\npost_revision_report\nbroker.project_changed()\nsave_identity",
    commands: "pub(crate) async fn get_workspace_plugin_transition\nPluginLifecycleQueryService\n.get_transition(",
    frontend: "command === \"get_workspace_plugin_transition\"\nrecovery_required: \"Recovery required\"\nstatus === \"recovery_required\"\nno completion is claimed",
    workspace: 'version = "0.4.1-dev.11"',
    tauri: '{"version":"0.4.1-dev.11"}',
    packageJson: '{"version":"0.4.1-dev.11"}',
    news: "## 0.4.1-dev.11\n### Workspace-plugin crash-point recovery truth",
    installed: 'report["recovery_incomplete_uninstall"] = json!(true)\nreport["recovery_project_revision_once"] = json!(true)\nreport["recovery_purge_pending"] = json!(true)',
    spec: "Activated P2-4F contract — 2026-08-21",
  };
}

if (process.argv.includes("--test")) {
  validateP24RecoveryCloseout(fixture());
  for (const [name, mutate] of [
    ["uninstall", (value) => { value.runtime = value.runtime.replace("reconciliation_finishes_incomplete_uninstall_and_moves_files_once", ""); }],
    ["purge", (value) => { value.runtime = value.runtime.replace("reconciliation_replays_purge_pending_and_preserves_terminal_tombstone", ""); }],
    ["replacement", (value) => { value.runtime = value.runtime.replaceAll("interrupted_replacement", ""); }],
    ["revision", (value) => { value.main = value.main.replace("post_revision_reconciliation", ""); }],
    ["UI", (value) => { value.frontend = value.frontend.replace('recovery_required: "Recovery required"', ""); }],
    ["installed", (value) => { value.installed = value.installed.replace('report["recovery_project_revision_once"] = json!(true)', ""); }],
    ["version", (value) => { value.workspace = 'version = "0.4.1-dev.10"'; }],
    ["install", (value) => { value.commands += "\ninstall_workspace_plugin"; }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateP24RecoveryCloseout(value), undefined, name);
  }
} else {
  validateP24RecoveryCloseout({
    runtime: read("desktop/src-tauri/src/workspace_plugins.rs"),
    store: read("crates/rho-store/src/plugin_lifecycle.rs"),
    main: read("desktop/src-tauri/src/main.rs"),
    commands: read("desktop/src-tauri/src/commands/plugins.rs"),
    frontend: read("desktop/dist/app.js"),
    workspace: read("Cargo.toml"),
    tauri: read("desktop/src-tauri/tauri.conf.json"),
    packageJson: read("desktop/package.json"),
    news: read("NEWS.md"),
    installed: read("desktop/src-tauri/src/main.rs"),
    spec: read("docs/plans/implemented-2026-08-20-p2-4-plugin-lifecycle-recovery-upgrade-spec.md"),
  });
}

console.log("extension P2-4 recovery closeout contract passed");
