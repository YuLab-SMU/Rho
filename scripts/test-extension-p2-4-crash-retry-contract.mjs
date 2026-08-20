import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validateP24CrashRetryContract(value) {
  for (const marker of [
    "WorkspacePluginCrashOutcome",
    "record_workspace_plugin_crash",
    "host_quarantined",
    "crash_loop_blocked",
    "Duration::minutes(10)",
    "crash_count >= 3",
  ]) assert.ok(value.store.includes(marker), `durable crash truth lost ${marker}`);
  for (const marker of [
    "ActiveCrashIdentity",
    "persist_crash_if_needed",
    "quarantine_timed_out_plugin",
    "sweep_project_heartbeats",
    '"heartbeat_timeout"',
    "pub(crate) fn retry(",
    "prepare_retry_transition",
    'kind: "retry"',
    "blocked after repeated crashes",
    "contribution_crashes_are_durable_retry_is_fresh_and_third_crash_blocks",
    "heartbeat_timeout_closes_exact_host_and_retry_reconstructs",
    "crash_persistence_failure_never_restores_route_and_blocks_recovery",
  ]) assert.ok(value.desktop.includes(marker), `crash/Retry coordinator lost ${marker}`);
  for (const marker of [
    "pub(crate) async fn retry_workspace_plugin",
    "expected_project_revision",
    "Workspace plugin Retry is stale after a project change",
  ]) assert.ok(value.commands.includes(marker), `trusted Retry command lost ${marker}`);
  for (const marker of [
    "monitor_workspace_plugin_heartbeats",
    "DEFAULT_HEARTBEAT_INTERVAL",
    "workspace_plugin_heartbeat_sweep",
  ]) assert.ok(value.main.includes(marker), `heartbeat monitor wiring lost ${marker}`);
  for (const marker of [
    'command === "retry_workspace_plugin"',
    "async function retryWorkspacePlugin(pluginId)",
    "data-plugin-retry",
    'retry.textContent = "Retry"',
    'status === "blocked"',
  ]) assert.ok(value.frontend.includes(marker), `Retry UI/mock lost ${marker}`);
  assert.match(value.workspace, /version = "0\.4\.1-dev\.7"/);
  assert.equal(JSON.parse(value.tauri).version, "0.4.1-dev.7");
  assert.equal(JSON.parse(value.packageJson).version, "0.4.1-dev.7");
  assert.match(value.news, /## 0\.4\.1-dev\.7[\s\S]*Workspace-plugin crash recovery/);
  for (const marker of [
    '"crash_state_durable": true',
    '"heartbeat_timeout_classified": true',
    '"retry_fresh_authority": true',
    '"third_crash_blocked": true',
  ]) assert.ok(value.installed.includes(marker), `installed C3 smoke lost ${marker}`);
  assert.match(value.spec, /Active work package: none at the P2-4C3\/P2-4C checkpoint/);
  assert.match(value.spec, /P2-4C3 \/ P2-4C local checkpoint — 2026-08-20/);
  assert.doesNotMatch(
    value.commands,
    /uninstall_workspace_plugin|accept_workspace_plugin_update|rollback_workspace_plugin/,
    "C3 prematurely added a later lifecycle command",
  );
}

function fixture() {
  return {
    store: "WorkspacePluginCrashOutcome\nrecord_workspace_plugin_crash\nhost_quarantined\ncrash_loop_blocked\nDuration::minutes(10)\ncrash_count >= 3",
    desktop: "ActiveCrashIdentity\npersist_crash_if_needed\nquarantine_timed_out_plugin\nsweep_project_heartbeats\n\"heartbeat_timeout\"\npub(crate) fn retry(\nprepare_retry_transition\nkind: \"retry\"\nblocked after repeated crashes\ncontribution_crashes_are_durable_retry_is_fresh_and_third_crash_blocks\nheartbeat_timeout_closes_exact_host_and_retry_reconstructs\ncrash_persistence_failure_never_restores_route_and_blocks_recovery",
    commands: "pub(crate) async fn retry_workspace_plugin\nexpected_project_revision\nWorkspace plugin Retry is stale after a project change",
    main: "monitor_workspace_plugin_heartbeats\nDEFAULT_HEARTBEAT_INTERVAL\nworkspace_plugin_heartbeat_sweep",
    frontend: "command === \"retry_workspace_plugin\"\nasync function retryWorkspacePlugin(pluginId)\ndata-plugin-retry\nretry.textContent = \"Retry\"\nstatus === \"blocked\"",
    workspace: 'version = "0.4.1-dev.7"',
    tauri: '{"version":"0.4.1-dev.7"}',
    packageJson: '{"version":"0.4.1-dev.7"}',
    news: "## 0.4.1-dev.7\n### Workspace-plugin crash recovery",
    installed: '"crash_state_durable": true\n"heartbeat_timeout_classified": true\n"retry_fresh_authority": true\n"third_crash_blocked": true',
    spec: "Active work package: none at the P2-4C3/P2-4C checkpoint\nP2-4C3 / P2-4C local checkpoint — 2026-08-20",
  };
}

if (process.argv.includes("--test")) {
  validateP24CrashRetryContract(fixture());
  for (const [name, mutate] of [
    ["crash window", (value) => { value.store = value.store.replace("Duration::minutes(10)", ""); }],
    ["route cleanup", (value) => { value.desktop = value.desktop.replace("persist_crash_if_needed", ""); }],
    ["blocked Retry", (value) => { value.desktop = value.desktop.replace("blocked after repeated crashes", ""); }],
    ["stale command", (value) => { value.commands = value.commands.replace("expected_project_revision", ""); }],
    ["mock", (value) => { value.frontend = value.frontend.replace('command === "retry_workspace_plugin"', ""); }],
    ["version", (value) => { value.workspace = 'version = "0.4.1-dev.6"'; }],
    ["later command", (value) => { value.commands += "\nuninstall_workspace_plugin"; }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateP24CrashRetryContract(value), undefined, name);
  }
} else {
  validateP24CrashRetryContract({
    store: read("crates/rho-store/src/plugin_lifecycle.rs"),
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

console.log("extension P2-4 crash and Retry contract passed");
