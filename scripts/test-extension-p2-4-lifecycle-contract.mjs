import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validateP24LifecycleContract(value) {
  const schemaVersion = value.store.match(/SCHEMA_VERSION: i64 = (\d+)/);
  assert.ok(schemaVersion, "rho-store must declare an integer schema version");
  assert.ok(
    Number.parseInt(schemaVersion[1], 10) >= 14,
    "the current store schema must include the v14 plugin lifecycle foundation",
  );
  for (const marker of [
    "mod plugin_lifecycle;",
    "mod plugin_lifecycle_service;",
    "pub use plugin_lifecycle::{",
    "pub use plugin_lifecycle_service::{PluginLifecycleMutationService, PluginLifecycleQueryService};",
    "migration::create_plugin_lifecycle_schema",
    "migration::assert_plugin_lifecycle_schema",
  ]) assert.ok(value.store.includes(marker), `rho-store lifecycle wiring lost ${marker}`);
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
    "complete_workspace_plugin_uninstall",
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
}

function fixture() {
  return {
    store: "SCHEMA_VERSION: i64 = 14\nmod plugin_lifecycle;\nmod plugin_lifecycle_service;\npub use plugin_lifecycle::{\npub use plugin_lifecycle_service::{PluginLifecycleMutationService, PluginLifecycleQueryService};\nmigration::create_plugin_lifecycle_schema\nmigration::assert_plugin_lifecycle_schema",
    migration: "create_plugin_lifecycle_schema\nworkspace_plugin_states\nworkspace_plugin_transitions\nworkspace_plugin_lifecycle_events\nworkspace_plugin_package_tombstones\nidx_workspace_plugin_transitions_one_active\npub(crate) fn assert_plugin_lifecycle_schema\ninvalid_plugin_lifecycle_authority",
    lifecycle: "WorkspacePluginState\nWorkspacePluginTransition\nWorkspacePluginLifecycleEvent\nWorkspacePluginPackageTombstone\nrequest_workspace_plugin_transition\nadvance_workspace_plugin_transition\nallocate_workspace_plugin_generation\ncomplete_workspace_plugin_uninstall\nexpected_old_digest\ncompletion_uncertain\nplugin lifecycle details contain a forbidden field\n#[cfg(test)]",
    service: "PluginLifecycleQueryService\nPluginLifecycleMutationService\nrequired_project_root\ndoes not match service project",
  };
}

if (process.argv.includes("--test")) {
  validateP24LifecycleContract(fixture());
  for (const [name, mutate] of [
    ["schema version", (value) => { value.store = value.store.replace("SCHEMA_VERSION: i64 = 14", "SCHEMA_VERSION: i64 = 13"); }],
    ["module wiring", (value) => { value.store = value.store.replace("mod plugin_lifecycle_service;", ""); }],
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
  });
}

console.log("extension P2-4 lifecycle persistence contract passed");
