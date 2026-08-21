import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validateP24TrustedRollback(value) {
  for (const marker of [
    "WorkspacePluginRollbackInput",
    "PendingActivationKind::Rollback",
    "pub(crate) fn request_rollback(",
    "workspace plugin Rollback is stale after a project change",
    "workspace plugin Rollback pointers are stale",
    ".load_exact(",
    "plan_fresh_plugin_permissions",
    'kind: "rollback"',
    "rollback_permission_request_failed",
    '"plugin_rolled_back"',
    "exact_cached_rollback_is_fresh_and_restart_reconstructs_accepted_cache",
    "rollback_forces_fresh_target_grant_and_revokes_current_digest_grant",
    "rollback_rejects_stale_missing_cache_and_foreign_pointer_without_route_change",
  ]) assert.ok(value.runtime.includes(marker), `E3 trusted Rollback lost ${marker}`);
  for (const marker of [
    "lifecycle.rollback_digest.as_deref() == Some(plugin.digest.as_str())",
    "accepted Rollback cache is unavailable during restart",
    "discovered_from_cache",
    "cached_override",
  ]) assert.ok(value.runtime.includes(marker), `E3 restart cache truth lost ${marker}`);
  for (const marker of [
    "pub(crate) async fn rollback_workspace_plugin",
    "project_transition_gate.lock().await",
    ".request_rollback(",
  ]) assert.ok(value.commands.includes(marker), `E3 command lost ${marker}`);
  for (const marker of [
    'command === "rollback_workspace_plugin"',
    "reviewWorkspacePluginRollback(pluginId)",
    "confirmWorkspacePluginRollback()",
    "data-plugin-rollback",
    "expectedCurrentDigest",
    "rollbackDigest",
  ]) assert.ok(value.frontend.includes(marker), `E3 UI/mock lost ${marker}`);
  for (const marker of [
    'id="pluginRollbackView"',
    'id="pluginRollbackIdentity"',
    'id="pluginRollbackConfirm"',
    "Historical grants, handles, hosts, and generations are never restored",
    "does not rewrite the newer project package",
  ]) assert.ok(value.html.includes(marker), `E3 fixed review lost ${marker}`);
  assert.match(value.workspace, /version = "0\.4\.1-dev\.11"/);
  assert.equal(JSON.parse(value.tauri).version, "0.4.1-dev.11");
  assert.equal(JSON.parse(value.packageJson).version, "0.4.1-dev.11");
  assert.match(value.news, /## 0\.4\.1-dev\.10[\s\S]*Exact cached workspace-plugin Rollback/);
  for (const marker of [
    'report["rollback_exact_cache_only"] = json!(true)',
    'report["rollback_fresh_authority"] = json!(true)',
    'report["rollback_pointer_reversed"] = json!(true)',
    'report["rollback_source_unchanged"] = json!(true)',
    'report["rollback_restart_cached"] = json!(true)',
  ]) assert.ok(value.installed.includes(marker), `installed E3 smoke lost ${marker}`);
  assert.match(value.spec, /P2-4E3 — trusted Rollback and restart truth \(locally complete\)/);
  assert.doesNotMatch(value.commands, /\binstall_workspace_plugin\b/, "E3 added install authority");
}

function fixture() {
  return {
    runtime: "WorkspacePluginRollbackInput\nPendingActivationKind::Rollback\npub(crate) fn request_rollback(\nworkspace plugin Rollback is stale after a project change\nworkspace plugin Rollback pointers are stale\n.load_exact(\nplan_fresh_plugin_permissions\nkind: \"rollback\"\nrollback_permission_request_failed\n\"plugin_rolled_back\"\nexact_cached_rollback_is_fresh_and_restart_reconstructs_accepted_cache\nrollback_forces_fresh_target_grant_and_revokes_current_digest_grant\nrollback_rejects_stale_missing_cache_and_foreign_pointer_without_route_change\nlifecycle.rollback_digest.as_deref() == Some(plugin.digest.as_str())\naccepted Rollback cache is unavailable during restart\ndiscovered_from_cache\ncached_override",
    commands: "pub(crate) async fn rollback_workspace_plugin\nproject_transition_gate.lock().await\n.request_rollback(",
    frontend: "command === \"rollback_workspace_plugin\"\nreviewWorkspacePluginRollback(pluginId)\nconfirmWorkspacePluginRollback()\ndata-plugin-rollback\nexpectedCurrentDigest\nrollbackDigest",
    html: 'id="pluginRollbackView"\nid="pluginRollbackIdentity"\nid="pluginRollbackConfirm"\nHistorical grants, handles, hosts, and generations are never restored\ndoes not rewrite the newer project package',
    workspace: 'version = "0.4.1-dev.11"',
    tauri: '{"version":"0.4.1-dev.11"}',
    packageJson: '{"version":"0.4.1-dev.11"}',
    news: "## 0.4.1-dev.10\n### Exact cached workspace-plugin Rollback",
    installed: 'report["rollback_exact_cache_only"] = json!(true)\nreport["rollback_fresh_authority"] = json!(true)\nreport["rollback_pointer_reversed"] = json!(true)\nreport["rollback_source_unchanged"] = json!(true)\nreport["rollback_restart_cached"] = json!(true)',
    spec: "P2-4E3 — trusted Rollback and restart truth (locally complete)",
  };
}

if (process.argv.includes("--test")) {
  validateP24TrustedRollback(fixture());
  for (const [name, mutate] of [
    ["cache", (value) => { value.runtime = value.runtime.replace(".load_exact(", ""); }],
    ["fresh permissions", (value) => { value.runtime = value.runtime.replace("plan_fresh_plugin_permissions", ""); }],
    ["restart pair", (value) => { value.runtime = value.runtime.replace("lifecycle.rollback_digest.as_deref() == Some(plugin.digest.as_str())", ""); }],
    ["command gate", (value) => { value.commands = value.commands.replace("project_transition_gate.lock().await", ""); }],
    ["UI", (value) => { value.frontend = value.frontend.replace("data-plugin-rollback", ""); }],
    ["installed", (value) => { value.installed = value.installed.replace('report["rollback_restart_cached"] = json!(true)', ""); }],
    ["version", (value) => { value.workspace = 'version = "0.4.1-dev.10"'; }],
    ["install", (value) => { value.commands += "\ninstall_workspace_plugin"; }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateP24TrustedRollback(value), undefined, name);
  }
} else {
  validateP24TrustedRollback({
    runtime: read("desktop/src-tauri/src/workspace_plugins.rs"),
    commands: read("desktop/src-tauri/src/commands/plugins.rs"),
    frontend: read("desktop/dist/app.js"),
    html: read("desktop/dist/index.html"),
    workspace: read("Cargo.toml"),
    tauri: read("desktop/src-tauri/tauri.conf.json"),
    packageJson: read("desktop/package.json"),
    news: read("NEWS.md"),
    installed: read("desktop/src-tauri/src/main.rs"),
    spec: read("docs/plans/active-2026-08-20-p2-4-plugin-lifecycle-recovery-upgrade-spec.md"),
  });
}

console.log("extension P2-4 trusted Rollback contract passed");
