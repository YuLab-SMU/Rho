import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validateP24ReplacementFoundation(value) {
  for (const marker of [
    "WorkspacePluginReplacementCompletion",
    "complete_workspace_plugin_replacement",
    '"upgrade" | "rollback"',
    'transition.phase == "pointer_swapped"',
    "accepted_digest = ?3",
    "rollback_digest = ?4",
    "replacement_completion_atomically_swaps_and_reverses_digest_pointers",
    "replacement_terminal_event_failure_rolls_back_pointer_and_reopens",
    "concurrent_replacement_completion_has_one_pointer_winner",
  ]) assert.ok(value.store.includes(marker), `E1 atomic pointer truth lost ${marker}`);
  for (const marker of [
    "expected_old_contribution",
    "activate_plugin_replacement_durable",
    "replacement expected-old runtime identity changed",
    ".publish(",
    "Some(expected_old_identity)",
    "complete_replacement",
    "hidden_replacement_uses_expected_old_cas_and_fresh_runtime_identity",
    "replacement_candidate_failure_preserves_exact_old_route",
    "replacement_terminal_persistence_failure_closes_old_and_candidate_routes",
  ]) {
    const present = marker === "Some(expected_old_identity)"
      ? value.runtime.includes("prepared.expected_old_contribution.as_ref()")
      : value.runtime.includes(marker);
    assert.ok(present, `E1 hidden runtime replacement lost ${marker}`);
  }
  assert.match(value.workspace, /version = "0\.4\.1-dev\.11"/);
  assert.equal(JSON.parse(value.tauri).version, "0.4.1-dev.11");
  assert.match(value.spec, /P2-4E1 — replacement\/pointer foundation \(locally complete\)/);
  assert.doesNotMatch(
    value.commands,
    /\binstall_workspace_plugin\b/,
    "E1 prematurely added Update or Rollback commands",
  );
  assert.doesNotMatch(value.frontend, /data-plugin-install/, "E1 contract saw install UI");
}

function fixture() {
  return {
    store: "WorkspacePluginReplacementCompletion\ncomplete_workspace_plugin_replacement\n\"upgrade\" | \"rollback\"\ntransition.phase == \"pointer_swapped\"\naccepted_digest = ?3\nrollback_digest = ?4\nreplacement_completion_atomically_swaps_and_reverses_digest_pointers\nreplacement_terminal_event_failure_rolls_back_pointer_and_reopens\nconcurrent_replacement_completion_has_one_pointer_winner",
    runtime: "expected_old_contribution\nactivate_plugin_replacement_durable\nreplacement expected-old runtime identity changed\n.publish(\nprepared.expected_old_contribution.as_ref()\ncomplete_replacement\nhidden_replacement_uses_expected_old_cas_and_fresh_runtime_identity\nreplacement_candidate_failure_preserves_exact_old_route\nreplacement_terminal_persistence_failure_closes_old_and_candidate_routes",
    workspace: 'version = "0.4.1-dev.11"',
    tauri: '{"version":"0.4.1-dev.11"}',
    spec: "P2-4E1 — replacement/pointer foundation (locally complete)",
    commands: "list_workspace_plugins",
    frontend: "Workspace Plugins",
  };
}

if (process.argv.includes("--test")) {
  validateP24ReplacementFoundation(fixture());
  for (const [name, mutate] of [
    ["pointer", (value) => { value.store = value.store.replace("rollback_digest = ?4", ""); }],
    ["expected old", (value) => { value.runtime = value.runtime.replace("prepared.expected_old_contribution.as_ref()", ""); }],
    ["old route", (value) => { value.runtime = value.runtime.replace("replacement_candidate_failure_preserves_exact_old_route", ""); }],
    ["terminal failure", (value) => { value.runtime = value.runtime.replace("replacement_terminal_persistence_failure_closes_old_and_candidate_routes", ""); }],
    ["version", (value) => { value.workspace = 'version = "0.4.1-dev.10"'; }],
    ["command", (value) => { value.commands += "\ninstall_workspace_plugin"; }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateP24ReplacementFoundation(value), undefined, name);
  }
} else {
  validateP24ReplacementFoundation({
    store: read("crates/rho-store/src/plugin_lifecycle.rs"),
    runtime: read("desktop/src-tauri/src/workspace_plugins.rs"),
    workspace: read("Cargo.toml"),
    tauri: read("desktop/src-tauri/tauri.conf.json"),
    spec: read("docs/plans/implemented-2026-08-20-p2-4-plugin-lifecycle-recovery-upgrade-spec.md"),
    commands: read("desktop/src-tauri/src/commands/plugins.rs"),
    frontend: read("desktop/dist/app.js"),
  });
}

console.log("extension P2-4 replacement foundation contract passed");
