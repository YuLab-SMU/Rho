import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validateP24DisableContract(value) {
  for (const marker of [
    "WorkspacePluginDisableResult",
    "pub(crate) fn disable(",
    "transition_kind.replace('_', \"-\")",
    '"routing_closed"',
    '"calls_drained"',
    '"handles_revoked"',
    '"contributions_disposed"',
    '"host_disposed"',
    '"completion_uncertain"',
    "active_broker_request_id",
    "cancel_broker_call",
    "invalidate_host",
    "quarantine_for_timeout",
    "record_disable_phase",
    "explicit_disable_closes_routes_revokes_handles_and_persists_terminal_truth",
    "disable_cancels_permission_pending_enable_before_starting_a_new_transition",
    "disable_cancels_exact_yielded_guest_call_and_withholds_late_route",
    "disable_forces_guest_dispose_failure_but_still_completes_non_routable",
    "disable_persistence_failure_after_route_close_is_completion_uncertain",
    "disable_is_project_scoped_and_concurrent_duplicates_converge",
  ]) assert.ok(value.desktop.includes(marker), `explicit Disable lost ${marker}`);
  assert.doesNotMatch(
    value.desktop.slice(
      value.desktop.indexOf("pub(crate) struct WorkspacePluginDisableResult"),
      value.desktop.indexOf("pub(crate) struct WorkspacePluginReconciliationReport"),
    ),
    /handle_id|credential|payload|full_path|wasm_memory/i,
    "Disable result exposed authority or sensitive payload fields",
  );
  for (const marker of [
    "pub(crate) async fn disable_workspace_plugin",
    "expected_project_revision",
    "Workspace plugin disable request is stale after a project change",
  ]) assert.ok(value.commands.includes(marker), `trusted Disable command lost ${marker}`);
  assert.match(value.main, /commands::plugins::disable_workspace_plugin/);
  for (const marker of [
    'command === "disable_workspace_plugin"',
    "async function disableWorkspacePlugin(pluginId)",
    "data-plugin-disable",
    'disable.textContent = "Disable"',
    "route_closed: true",
    'status: "disabled"',
  ]) assert.ok(value.frontend.includes(marker), `Disable UI/mock lost ${marker}`);
  assert.match(value.news, /## 0\.4\.1-dev\.6[\s\S]*Workspace-plugin disable/);
  for (const marker of [
    '"explicit_disable": true',
    '"disable_route_closed": true',
    '"disable_host_disposed": true',
    '"disable_terminal_durable": true',
  ]) assert.ok(value.installed.includes(marker), `installed C1 smoke lost ${marker}`);
  assert.match(value.spec, /P2-4C1 local checkpoint — 2026-08-20/);
  assert.doesNotMatch(
    value.commands,
    /\binstall_workspace_plugin\b/,
    "C1 prematurely added a later lifecycle command",
  );
}

function fixture() {
  return {
    desktop: "pub(crate) struct WorkspacePluginDisableResult\nroute_closed\npub(crate) struct WorkspacePluginReconciliationReport\npub(crate) fn disable(\ntransition_kind.replace('_', \"-\")\n\"routing_closed\"\n\"calls_drained\"\n\"handles_revoked\"\n\"contributions_disposed\"\n\"host_disposed\"\n\"completion_uncertain\"\nactive_broker_request_id\ncancel_broker_call\ninvalidate_host\nquarantine_for_timeout\nrecord_disable_phase\nexplicit_disable_closes_routes_revokes_handles_and_persists_terminal_truth\ndisable_cancels_permission_pending_enable_before_starting_a_new_transition\ndisable_cancels_exact_yielded_guest_call_and_withholds_late_route\ndisable_forces_guest_dispose_failure_but_still_completes_non_routable\ndisable_persistence_failure_after_route_close_is_completion_uncertain\ndisable_is_project_scoped_and_concurrent_duplicates_converge",
    commands: "pub(crate) async fn disable_workspace_plugin\nexpected_project_revision\nWorkspace plugin disable request is stale after a project change",
    main: "commands::plugins::disable_workspace_plugin",
    frontend: "command === \"disable_workspace_plugin\"\nasync function disableWorkspacePlugin(pluginId)\ndata-plugin-disable\ndisable.textContent = \"Disable\"\nroute_closed: true\nstatus: \"disabled\"",
    workspace: 'version = "0.4.1-dev.6"',
    tauri: '{"version":"0.4.1-dev.6"}',
    packageJson: '{"version":"0.4.1-dev.6"}',
    news: "## 0.4.1-dev.6\n### Workspace-plugin disable",
    installed: '"explicit_disable": true\n"disable_route_closed": true\n"disable_host_disposed": true\n"disable_terminal_durable": true',
    spec: "P2-4C1 local checkpoint — 2026-08-20",
  };
}

if (process.argv.includes("--test")) {
  validateP24DisableContract(fixture());
  for (const [name, mutate] of [
    ["route close", (value) => { value.desktop = value.desktop.replace('"routing_closed"', ""); }],
    ["exact cancel", (value) => { value.desktop = value.desktop.replace("active_broker_request_id", ""); }],
    ["uncertainty", (value) => { value.desktop = value.desktop.replace('"completion_uncertain"', ""); }],
    ["stale command", (value) => { value.commands = value.commands.replace("expected_project_revision", ""); }],
    ["mock", (value) => { value.frontend = value.frontend.replace('command === "disable_workspace_plugin"', ""); }],
    ["later command", (value) => { value.commands += "\ninstall_workspace_plugin"; }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateP24DisableContract(value), undefined, name);
  }
} else {
  validateP24DisableContract({
    desktop: read("desktop/src-tauri/src/workspace_plugins.rs"),
    commands: read("desktop/src-tauri/src/commands/plugins.rs"),
    main: read("desktop/src-tauri/src/main.rs"),
    frontend: read("desktop/dist/app.js"),
    workspace: read("Cargo.toml"),
    tauri: read("desktop/src-tauri/tauri.conf.json"),
    packageJson: read("desktop/package.json"),
    news: read("NEWS.md"),
    installed: read("desktop/src-tauri/src/main.rs"),
    spec: read("docs/plans/active-2026-08-20-p2-4-plugin-lifecycle-recovery-upgrade-spec.md"),
  });
}

console.log("extension P2-4 explicit Disable contract passed");
