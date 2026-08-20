import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validateP24DurableEnableContract(value) {
  for (const marker of [
    "PluginLifecycleMutationService",
    "PluginLifecycleQueryService",
    "PluginPackageCache::new",
    "WorkspacePluginDiscoveredDraft",
    "WorkspacePluginTransitionDraft",
    "WorkspacePluginTransitionAdvance",
    "transition.enable.",
    '"preflight"',
    '"backup_prepared"',
    '"grants_ready"',
    '"candidate_activated"',
    '"pointer_swapped"',
    '"transition_completed"',
    "allocate_generation",
    "prepare_plugin_activation",
    ".publish(prepared.contribution_candidate, None)",
    "remove_active_plugin(state, &key)",
    "fail_enable_transition",
    "post_publication_persistence_failure_closes_routes_and_leaves_recovery_truth",
    "changed_package_stays_update_pending_and_keeps_old_route",
  ]) assert.ok(value.desktop.includes(marker), `durable first enable lost ${marker}`);

  const skillStart = value.desktop.indexOf("fn read_plugin_skill(");
  const skillEnd = value.desktop.indexOf("fn remove_active_plugin", skillStart);
  const skillReader = value.desktop.slice(skillStart, skillEnd);
  assert.doesNotMatch(
    skillReader,
    /std::fs|fs::|discover_workspace_plugins|discover_exact_plugin|File::open|read_to_end/,
    "live Skill projection returned to mutable project files",
  );

  for (const marker of [
    "pub desired_state: String",
    "pub observed_state: String",
    "pub accepted_digest: Option<String>",
    "pub transition_id: Option<String>",
  ]) assert.ok(value.desktop.includes(marker), `trusted plugin view lost ${marker}`);
  assert.match(value.workspace, /version = "0\.4\.1-dev\.5"/);
  assert.equal(JSON.parse(value.tauri).version, "0.4.1-dev.5");
  assert.equal(JSON.parse(value.packageJson).version, "0.4.1-dev.5");
  assert.match(value.news, /## 0\.4\.1-dev\.5[\s\S]*Durable workspace-plugin enablement/);
  for (const marker of [
    "desired_state",
    "observed_state",
    "accepted_digest",
    "transition_id",
    'enabling: "Enabling"',
    'update_pending: "Update pending"',
    "exact cached plugin package is durably enabled",
  ]) assert.ok(value.frontend.includes(marker), `browser/mock durable enable lost ${marker}`);
  for (const marker of [
    '"schema_v14_lifecycle": true',
    '"exact_package_cache": true',
    '"durable_first_enable": true',
    '"durable_activation_generation": 1',
    '"durable_completion_after_routing": true',
  ]) assert.ok(value.installed.includes(marker), `installed B2 smoke lost ${marker}`);
  assert.match(value.spec, /Active work package: none at the P2-4B2 checkpoint/);
  assert.match(value.spec, /P2-4B2 local checkpoint — 2026-08-20/);
  assert.match(value.spec, /P2-4B3 — restart reconstruction \(inactive\)/);
}

function fixture() {
  return {
    desktop: "PluginLifecycleMutationService\nPluginLifecycleQueryService\nPluginPackageCache::new\nWorkspacePluginDiscoveredDraft\nWorkspacePluginTransitionDraft\nWorkspacePluginTransitionAdvance\ntransition.enable.\n\"preflight\"\n\"backup_prepared\"\n\"grants_ready\"\n\"candidate_activated\"\n\"pointer_swapped\"\n\"transition_completed\"\nallocate_generation\nprepare_plugin_activation\n.publish(prepared.contribution_candidate, None)\nremove_active_plugin(state, &key)\nfail_enable_transition\npost_publication_persistence_failure_closes_routes_and_leaves_recovery_truth\nchanged_package_stays_update_pending_and_keeps_old_route\npub desired_state: String\npub observed_state: String\npub accepted_digest: Option<String>\npub transition_id: Option<String>\nfn read_plugin_skill(\nactive.skill_instructions\nfn remove_active_plugin",
    workspace: 'version = "0.4.1-dev.5"',
    tauri: '{"version":"0.4.1-dev.5"}',
    packageJson: '{"version":"0.4.1-dev.5"}',
    news: "## 0.4.1-dev.5\n### Durable workspace-plugin enablement",
    frontend: "desired_state\nobserved_state\naccepted_digest\ntransition_id\nenabling: \"Enabling\"\nupdate_pending: \"Update pending\"\nexact cached plugin package is durably enabled",
    installed: '"schema_v14_lifecycle": true\n"exact_package_cache": true\n"durable_first_enable": true\n"durable_activation_generation": 1\n"durable_completion_after_routing": true',
    spec: "Active work package: none at the P2-4B2 checkpoint\nP2-4B2 local checkpoint — 2026-08-20\nP2-4B3 — restart reconstruction (inactive)",
  };
}

if (process.argv.includes("--test")) {
  validateP24DurableEnableContract(fixture());
  for (const [name, mutate] of [
    ["generation", (value) => { value.desktop = value.desktop.replace("allocate_generation", ""); }],
    ["publication CAS", (value) => { value.desktop = value.desktop.replace(".publish(prepared.contribution_candidate, None)", ""); }],
    ["post-publication cleanup", (value) => { value.desktop = value.desktop.replace("remove_active_plugin(state, &key)", ""); }],
    ["mutable Skill", (value) => { value.desktop = value.desktop.replace("active.skill_instructions", "fs::read"); }],
    ["version", (value) => { value.workspace = 'version = "0.4.1-dev.4"'; }],
    ["installed", (value) => { value.installed = value.installed.replace('"durable_first_enable": true', ""); }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateP24DurableEnableContract(value), undefined, name);
  }
} else {
  validateP24DurableEnableContract({
    desktop: read("desktop/src-tauri/src/workspace_plugins.rs"),
    workspace: read("Cargo.toml"),
    tauri: read("desktop/src-tauri/tauri.conf.json"),
    packageJson: read("desktop/package.json"),
    news: read("NEWS.md"),
    frontend: read("desktop/dist/app.js"),
    installed: read("desktop/src-tauri/src/main.rs"),
    spec: read("docs/plans/active-2026-08-20-p2-4-plugin-lifecycle-recovery-upgrade-spec.md"),
  });
}

console.log("extension P2-4 durable first enable contract passed");
