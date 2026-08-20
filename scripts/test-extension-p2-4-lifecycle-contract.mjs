import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validateP24LifecycleContract(value) {
  assert.match(value.store, /SCHEMA_VERSION: i64 = 14/);
  for (const marker of [
    "create_plugin_lifecycle_schema",
    "assert_plugin_lifecycle_schema",
    "workspace_plugin_states",
    "workspace_plugin_transitions",
    "workspace_plugin_lifecycle_events",
    "workspace_plugin_package_tombstones",
    "idx_workspace_plugin_transitions_one_active",
    "invalid_plugin_lifecycle_authority",
  ]) assert.ok(value.migration.includes(marker), `schema v14 lost ${marker}`);
  const lifecycleSchema = value.migration.slice(
    value.migration.indexOf("create_plugin_lifecycle_schema"),
    value.migration.indexOf("pub(crate) fn assert_plugin_lifecycle_schema"),
  );
  assert.doesNotMatch(
    lifecycleSchema,
    /\bhandle_id\s+TEXT|\bcredential\s+TEXT|\bpayload_json\s+TEXT|\bwasm_memory\s+TEXT/,
    "lifecycle schema persisted live authority or sensitive payload fields",
  );

  for (const marker of [
    "WorkspacePluginState",
    "WorkspacePluginTransition",
    "WorkspacePluginLifecycleEvent",
    "WorkspacePluginPackageTombstone",
    "request_workspace_plugin_transition",
    "advance_workspace_plugin_transition",
    "allocate_workspace_plugin_generation",
    "record_workspace_plugin_tombstone",
    "expected_old_digest",
    "completion_uncertain",
    "plugin lifecycle details contain a forbidden field",
  ]) assert.ok(value.lifecycle.includes(marker), `lifecycle persistence lost ${marker}`);
  assert.doesNotMatch(
    value.lifecycle.split("#[cfg(test)]")[0],
    /std::fs|reqwest|WasmPluginHost|GrantStore|tauri::|Command::new/,
    "P2-4A persistence gained filesystem, network, Wasm, grant, Tauri, or process authority",
  );
  for (const marker of [
    "PluginLifecycleQueryService",
    "PluginLifecycleMutationService",
    "required_project_root",
    "does not match service project",
  ]) assert.ok(value.service.includes(marker), `lifecycle service seam lost ${marker}`);
  assert.match(value.spec, /Status: active under the owner-approved local-first exception/);
  assert.match(value.spec, /Active work package: none at the P2-4B3\/P2-4B checkpoint/);
  assert.match(value.spec, /P2-4A local checkpoint — 2026-08-20/);
  assert.match(value.crossReview, /plans\/active-2026-08-20-p2-4-plugin-lifecycle-recovery-upgrade-spec\.md/);
}

function fixture() {
  return {
    store: "SCHEMA_VERSION: i64 = 14",
    migration: "create_plugin_lifecycle_schema\nworkspace_plugin_states\nworkspace_plugin_transitions\nworkspace_plugin_lifecycle_events\nworkspace_plugin_package_tombstones\nidx_workspace_plugin_transitions_one_active\npub(crate) fn assert_plugin_lifecycle_schema\ninvalid_plugin_lifecycle_authority",
    lifecycle: "WorkspacePluginState\nWorkspacePluginTransition\nWorkspacePluginLifecycleEvent\nWorkspacePluginPackageTombstone\nrequest_workspace_plugin_transition\nadvance_workspace_plugin_transition\nallocate_workspace_plugin_generation\nrecord_workspace_plugin_tombstone\nexpected_old_digest\ncompletion_uncertain\nplugin lifecycle details contain a forbidden field\n#[cfg(test)]",
    service: "PluginLifecycleQueryService\nPluginLifecycleMutationService\nrequired_project_root\ndoes not match service project",
    spec: "Status: active under the owner-approved local-first exception\nActive work package: none at the P2-4B3/P2-4B checkpoint\nP2-4A local checkpoint — 2026-08-20",
    crossReview: "plans/active-2026-08-20-p2-4-plugin-lifecycle-recovery-upgrade-spec.md",
  };
}

if (process.argv.includes("--test")) {
  validateP24LifecycleContract(fixture());
  for (const [name, mutate] of [
    ["schema version", (value) => { value.store = "SCHEMA_VERSION: i64 = 13"; }],
    ["active transition uniqueness", (value) => { value.migration = value.migration.replace("idx_workspace_plugin_transitions_one_active", ""); }],
    ["raw handle", (value) => {
      value.migration = value.migration.replace(
        "pub(crate) fn assert_plugin_lifecycle_schema",
        "handle_id TEXT\npub(crate) fn assert_plugin_lifecycle_schema",
      );
    }],
    ["filesystem authority", (value) => { value.lifecycle = `std::fs\n${value.lifecycle}`; }],
    ["project seam", (value) => { value.service = value.service.replace("required_project_root", ""); }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateP24LifecycleContract(value), undefined, name);
  }
} else {
  validateP24LifecycleContract({
    store: read("crates/rho-store/src/lib.rs"),
    migration: read("crates/rho-store/src/migration.rs"),
    lifecycle: read("crates/rho-store/src/plugin_lifecycle.rs"),
    service: read("crates/rho-store/src/plugin_lifecycle_service.rs"),
    spec: read("docs/plans/active-2026-08-20-p2-4-plugin-lifecycle-recovery-upgrade-spec.md"),
    crossReview: read("docs/project/active-document-cross-review.md"),
  });
}

console.log("extension P2-4 lifecycle persistence contract passed");
