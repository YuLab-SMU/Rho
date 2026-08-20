import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validateP22BrokerContract(value) {
  for (const marker of [
    "pub enum GuestStep",
    "pub fn begin_broker_call",
    "pub fn resume_broker_call",
    "pub fn cancel_broker_call",
    "MAX_GUEST_BROKER_STEPS: usize = 8",
    "MAX_GUEST_STEP_BYTES: usize = 64 * 1024",
    "MAX_GUEST_BROKER_RESULT_BYTES: usize = 1024 * 1024",
    "module.imports().next().is_some()",
  ]) assert.ok(value.host.includes(marker), `Guest ABI V2 lost ${marker}`);
  assert.doesNotMatch(value.host, /func_wrap|wasmtime_wasi|WasiCtx|reqwest|std::fs/);

  for (const marker of [
    "rand::random()",
    "pub trait GrantClock",
    "pub trait GrantTokenSource",
    "pub fn revalidate_admitted",
    "pub fn durable_grant_id_for_handle",
    "complete_failure_before_dispatch",
    "WrongHostSession",
    "WrongPackageDigest",
    "WrongWorkspace",
  ]) assert.ok(value.grant.includes(marker), `grant monitor lost ${marker}`);

  for (const marker of [
    "pub fn read_project_file",
    "MAX_PLUGIN_FILE_READ_BYTES: u64 = 1024 * 1024",
    "symlink_metadata",
    "is_link_or_reparse",
    "NestedRepository",
    "canonical_file.starts_with(&canonical_root)",
    ".take(request.max_bytes + 1)",
    "after_canonical_file != canonical_file",
  ]) assert.ok(value.fileBroker.includes(marker), `project.fs.read lost ${marker}`);
  const fileProduction = value.fileBroker.split("#[cfg(test)]")[0];
  assert.doesNotMatch(fileProduction, /read_dir|OpenOptions|File::create|Command::new|reqwest/);

  for (const marker of [
    "'call_admitted'",
    "'call_completed'",
    "'completion_uncertain'",
  ]) assert.ok(value.migration.includes(marker), `permission schema lost ${marker}`);
  for (const marker of [
    "record_plugin_permission_call_event",
    "consume_allow_once",
    "plugin permission call details contain a forbidden field",
  ]) assert.ok(value.store.includes(marker), `permission persistence lost ${marker}`);

  for (const marker of [
    "invoke_plugin_with_hook",
    "read_project_file(",
    "revalidate_admitted",
    "call_admitted",
    "call_completed",
    "stale_after_dispatch",
    "resume_broker_call",
  ]) assert.ok(value.desktop.includes(marker), `desktop broker loop lost ${marker}`);
  assert.ok(
    value.desktop.indexOf("begin_broker_call") < value.desktop.indexOf("read_project_file("),
    "guest must yield before project file I/O",
  );
  assert.ok(
    value.desktop.indexOf("read_project_file(") < value.desktop.indexOf("resume_broker_call"),
    "project file I/O must finish before guest resume",
  );
}

function fixture() {
  return {
    host: "pub enum GuestStep\npub fn begin_broker_call\npub fn resume_broker_call\npub fn cancel_broker_call\nMAX_GUEST_BROKER_STEPS: usize = 8\nMAX_GUEST_STEP_BYTES: usize = 64 * 1024\nMAX_GUEST_BROKER_RESULT_BYTES: usize = 1024 * 1024\nmodule.imports().next().is_some()",
    grant: "rand::random()\npub trait GrantClock\npub trait GrantTokenSource\npub fn revalidate_admitted\npub fn durable_grant_id_for_handle\ncomplete_failure_before_dispatch\nWrongHostSession\nWrongPackageDigest\nWrongWorkspace",
    fileBroker: "pub fn read_project_file\nMAX_PLUGIN_FILE_READ_BYTES: u64 = 1024 * 1024\nsymlink_metadata\nis_link_or_reparse\nNestedRepository\ncanonical_file.starts_with(&canonical_root)\n.take(request.max_bytes + 1)\nafter_canonical_file != canonical_file\n#[cfg(test)]",
    migration: "'call_admitted'\n'call_completed'\n'completion_uncertain'",
    store: "record_plugin_permission_call_event\nconsume_allow_once\nplugin permission call details contain a forbidden field",
    desktop: "begin_broker_call\ninvoke_plugin_with_hook\ncall_admitted\nread_project_file(\nrevalidate_admitted\ncall_completed\nstale_after_dispatch\nresume_broker_call",
  };
}

if (process.argv.includes("--test")) {
  validateP22BrokerContract(fixture());
  for (const [name, mutate] of [
    ["WASI", (value) => { value.host += "\nwasmtime_wasi"; }],
    ["unbounded read", (value) => { value.fileBroker = value.fileBroker.replace(".take(request.max_bytes + 1)", ""); }],
    ["no post-revoke check", (value) => { value.desktop = value.desktop.replace("revalidate_admitted", ""); }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateP22BrokerContract(value), undefined, name);
  }
} else {
  validateP22BrokerContract({
    host: read("crates/rho-extension-runtime/src/wasm_host.rs"),
    grant: read("crates/rho-extension-runtime/src/grant.rs"),
    fileBroker: read("crates/rho-server/src/plugin_fs.rs"),
    migration: read("crates/rho-store/src/migration.rs"),
    store: read("crates/rho-store/src/plugin_permission.rs"),
    desktop: read("desktop/src-tauri/src/workspace_plugins.rs"),
  });
}

console.log("extension P2-2 broker contract passed");
