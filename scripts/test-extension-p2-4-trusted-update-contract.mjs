import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validateP24TrustedUpdate(value) {
  for (const marker of [
    "WorkspacePluginUpdateInput",
    "PendingActivationKind::Upgrade",
    "pub(crate) fn request_update(",
    "workspace plugin Update is stale after a project change",
    "workspace plugin Update pointers are stale",
    'kind: "upgrade"',
    "update_permission_request_failed",
    "activate_plugin_replacement_durable",
    "revoke_exact_durable_grants",
    '"plugin_updated"',
    "trusted_update_accepts_only_current_candidate_and_revokes_old_digest_grants",
    "update_denial_or_changed_candidate_preserves_old_route_and_pointer",
    "update_rejects_stale_revision_digest_and_foreign_project_before_cas",
    "exact_update_isolates_two_projects_with_same_plugin_id",
  ]) assert.ok(value.runtime.includes(marker), `E2 trusted Update lost ${marker}`);
  for (const marker of [
    "pub(crate) async fn accept_workspace_plugin_update",
    "project_transition_gate.lock().await",
    ".request_update(",
  ]) assert.ok(value.commands.includes(marker), `E2 command wiring lost ${marker}`);
  for (const marker of [
    'command === "accept_workspace_plugin_update"',
    "reviewWorkspacePluginUpdate(pluginId)",
    "confirmWorkspacePluginUpdate()",
    "data-plugin-update",
    "expectedOldDigest",
    "candidateDigest",
    "not a marketplace",
  ]) assert.ok(value.frontend.includes(marker), `E2 UI/mock lost ${marker}`);
  for (const marker of [
    'id="pluginUpdateView"',
    'id="pluginUpdateIdentity"',
    'id="pluginUpdateConfirm"',
    "This is not a marketplace",
  ]) assert.ok(value.html.includes(marker), `E2 fixed review surface lost ${marker}`);
  assert.match(value.workspace, /version = "0\.4\.1-dev\.10"/);
  assert.equal(JSON.parse(value.tauri).version, "0.4.1-dev.10");
  assert.equal(JSON.parse(value.packageJson).version, "0.4.1-dev.10");
  assert.match(value.news, /## 0\.4\.1-dev\.9[\s\S]*Exact local workspace-plugin Update/);
  for (const marker of [
    'report["update_local_candidate_only"] = json!(true)',
    'report["update_expected_old_cas"] = json!(true)',
    'report["update_pointer_durable"] = json!(true)',
    'report["update_generation_fresh"] = json!(true)',
  ]) assert.ok(value.installed.includes(marker), `installed E2 smoke lost ${marker}`);
  assert.match(value.spec, /P2-4E2 — trusted Update \(locally complete\)/);
  assert.doesNotMatch(value.commands, /\binstall_workspace_plugin\b/, "E2 contract saw install authority");
}

function fixture() {
  return {
    runtime: "WorkspacePluginUpdateInput\nPendingActivationKind::Upgrade\npub(crate) fn request_update(\nworkspace plugin Update is stale after a project change\nworkspace plugin Update pointers are stale\nkind: \"upgrade\"\nupdate_permission_request_failed\nactivate_plugin_replacement_durable\nrevoke_exact_durable_grants\n\"plugin_updated\"\ntrusted_update_accepts_only_current_candidate_and_revokes_old_digest_grants\nupdate_denial_or_changed_candidate_preserves_old_route_and_pointer\nupdate_rejects_stale_revision_digest_and_foreign_project_before_cas\nexact_update_isolates_two_projects_with_same_plugin_id",
    commands: "pub(crate) async fn accept_workspace_plugin_update\nproject_transition_gate.lock().await\n.request_update(",
    frontend: "command === \"accept_workspace_plugin_update\"\nreviewWorkspacePluginUpdate(pluginId)\nconfirmWorkspacePluginUpdate()\ndata-plugin-update\nexpectedOldDigest\ncandidateDigest\nnot a marketplace",
    html: 'id="pluginUpdateView"\nid="pluginUpdateIdentity"\nid="pluginUpdateConfirm"\nThis is not a marketplace',
    workspace: 'version = "0.4.1-dev.10"',
    tauri: '{"version":"0.4.1-dev.10"}',
    packageJson: '{"version":"0.4.1-dev.10"}',
    news: "## 0.4.1-dev.9\n### Exact local workspace-plugin Update",
    installed: 'report["update_local_candidate_only"] = json!(true)\nreport["update_expected_old_cas"] = json!(true)\nreport["update_pointer_durable"] = json!(true)\nreport["update_generation_fresh"] = json!(true)',
    spec: "P2-4E2 — trusted Update (locally complete)",
  };
}

if (process.argv.includes("--test")) {
  validateP24TrustedUpdate(fixture());
  for (const [name, mutate] of [
    ["fresh grants", (value) => { value.runtime = value.runtime.replace("revoke_exact_durable_grants", ""); }],
    ["project gate", (value) => { value.commands = value.commands.replace("project_transition_gate.lock().await", ""); }],
    ["mock", (value) => { value.frontend = value.frontend.replace('command === "accept_workspace_plugin_update"', ""); }],
    ["disclaimer", (value) => { value.html = value.html.replace("This is not a marketplace", ""); }],
    ["installed", (value) => { value.installed = value.installed.replace('report["update_expected_old_cas"] = json!(true)', ""); }],
    ["version", (value) => { value.workspace = 'version = "0.4.1-dev.9"'; }],
    ["install", (value) => { value.commands += "\ninstall_workspace_plugin"; }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateP24TrustedUpdate(value), undefined, name);
  }
} else {
  validateP24TrustedUpdate({
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

console.log("extension P2-4 trusted Update contract passed");
