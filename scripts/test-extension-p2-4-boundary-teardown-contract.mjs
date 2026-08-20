import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validateP24BoundaryTeardownContract(value) {
  for (const marker of [
    "WorkspacePluginBoundaryTeardownReport",
    "WorkspacePluginBoundaryTeardownEntry",
    "pub(crate) fn teardown_project(",
    '"project_teardown" | "shutdown"',
    "preserve_desired_state",
    "forced_non_routable",
    "push_boundary_teardown_entry",
    "boundary_teardown_preserves_enabled_intent_and_reconstructs_fresh",
    "boundary_teardown_continues_after_one_guest_failure_and_cancels_pending",
    "boundary_teardown_persistence_failure_forces_non_routable_and_continues",
  ]) assert.ok(value.desktop.includes(marker), `boundary teardown lost ${marker}`);
  assert.doesNotMatch(
    value.desktop.slice(
      value.desktop.indexOf("pub(crate) struct WorkspacePluginBoundaryTeardownReport"),
      value.desktop.indexOf("pub(crate) struct WorkspacePluginReconciliationReport"),
    ),
    /handle_id|credential|payload|full_path|wasm_memory/i,
    "boundary report exposed authority or sensitive payload fields",
  );
  for (const marker of [
    "teardown_workspace_plugins_for_boundary",
    "reconcile_workspace_plugins_for_boundary",
    '"workspace_restarted"',
    '"broker_shutdown"',
    '"project_switched"',
    '"project_switch_restored"',
    '"workspace_plugin_boundary_teardown"',
  ]) assert.ok(value.main.includes(marker), `boundary wiring lost ${marker}`);
  for (const marker of [
    '"project_teardown" | "shutdown"',
    '"enabled" | "disabled"',
    '"enabled_or_disabled"',
  ]) assert.ok(value.store.includes(marker), `boundary desired-state contract lost ${marker}`);
  for (const marker of [
    '"boundary_teardown_reused": true',
    '"boundary_enabled_intent_preserved": true',
    '"boundary_reactivated": true',
  ]) assert.ok(value.installed.includes(marker), `installed C2 smoke lost ${marker}`);
  assert.match(value.spec, /P2-4C2 local checkpoint — 2026-08-20/);
  assert.doesNotMatch(
    value.commands,
    /uninstall_workspace_plugin|accept_workspace_plugin_update|rollback_workspace_plugin/,
    "C2 prematurely added a later lifecycle command",
  );
}

function fixture() {
  return {
    desktop: "pub(crate) struct WorkspacePluginBoundaryTeardownReport\nWorkspacePluginBoundaryTeardownEntry\nattempted\nentries\npub(crate) struct WorkspacePluginReconciliationReport\npub(crate) fn teardown_project(\n\"project_teardown\" | \"shutdown\"\npreserve_desired_state\nforced_non_routable\npush_boundary_teardown_entry\nboundary_teardown_preserves_enabled_intent_and_reconstructs_fresh\nboundary_teardown_continues_after_one_guest_failure_and_cancels_pending\nboundary_teardown_persistence_failure_forces_non_routable_and_continues",
    main: "teardown_workspace_plugins_for_boundary\nreconcile_workspace_plugins_for_boundary\n\"workspace_restarted\"\n\"broker_shutdown\"\n\"project_switched\"\n\"project_switch_restored\"\n\"workspace_plugin_boundary_teardown\"",
    store: "\"project_teardown\" | \"shutdown\"\n\"enabled\" | \"disabled\"\n\"enabled_or_disabled\"",
    installed: '"boundary_teardown_reused": true\n"boundary_enabled_intent_preserved": true\n"boundary_reactivated": true',
    spec: "P2-4C2 local checkpoint — 2026-08-20",
    commands: "disable_workspace_plugin",
  };
}

if (process.argv.includes("--test")) {
  validateP24BoundaryTeardownContract(fixture());
  for (const [name, mutate] of [
    ["preserved desired", (value) => { value.desktop = value.desktop.replace("preserve_desired_state", ""); }],
    ["forced fallback", (value) => { value.desktop = value.desktop.replace("forced_non_routable", ""); }],
    ["shutdown wiring", (value) => { value.main = value.main.replace('"broker_shutdown"', ""); }],
    ["store intent", (value) => { value.store = value.store.replace('"enabled" | "disabled"', '"disabled"'); }],
    ["installed", (value) => { value.installed = value.installed.replace('"boundary_reactivated": true', ""); }],
    ["later command", (value) => { value.commands += "\nuninstall_workspace_plugin"; }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateP24BoundaryTeardownContract(value), undefined, name);
  }
} else {
  validateP24BoundaryTeardownContract({
    desktop: read("desktop/src-tauri/src/workspace_plugins.rs"),
    main: read("desktop/src-tauri/src/main.rs"),
    store: read("crates/rho-store/src/plugin_lifecycle.rs"),
    installed: read("desktop/src-tauri/src/main.rs"),
    spec: read("docs/plans/active-2026-08-20-p2-4-plugin-lifecycle-recovery-upgrade-spec.md"),
    commands: read("desktop/src-tauri/src/commands/plugins.rs"),
  });
}

console.log("extension P2-4 boundary teardown contract passed");
