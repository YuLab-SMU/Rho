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
    "P2_2_SMOKE_WASM",
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
    "GetFileInformationByHandle",
    "BY_HANDLE_FILE_INFORMATION",
    "FILE_FLAG_BACKUP_SEMANTICS",
    ".access_mode(FILE_READ_ATTRIBUTES)",
  ]) assert.ok(value.fileBroker.includes(marker), `project.fs.read lost ${marker}`);
  const fileProduction = value.fileBroker.split("#[cfg(test)]")[0];
  assert.doesNotMatch(fileProduction, /read_dir|File::create|Command::new|reqwest/);
  assert.doesNotMatch(
    fileProduction,
    /\.write\(true\)|\.create\(true\)|\.truncate\(true\)|\.append\(true\)/,
    "project.fs.read Windows identity probe gained write authority",
  );
  assert.doesNotMatch(
    fileProduction,
    /\.volume_serial_number\(\)|\.file_index\(\)/,
    "project.fs.read regressed to unstable Rust Windows MetadataExt APIs",
  );
  for (const marker of [
    "[target.'cfg(windows)'.dependencies]",
    'windows-sys = { version = "0.60"',
    '"Win32_Foundation"',
    '"Win32_Storage_FileSystem"',
  ]) assert.ok(value.serverCargo.includes(marker), `Windows file identity dependency lost ${marker}`);

  for (const marker of [
    "pub struct WorkspaceObjectReferenceRegistry",
    'request_type: "workspace.inspect_object"',
    "MAX_WORKSPACE_METADATA_BYTES: usize = 64 * 1024",
    "MAX_WORKSPACE_PREVIEW_BYTES: usize = 256 * 1024",
    "MAX_WORKSPACE_PREVIEW_ROWS: usize = 100",
    "MAX_WORKSPACE_PREVIEW_COLUMNS: usize = 50",
    "MAX_WORKSPACE_PREVIEW_DEPTH: usize = 4",
    "ObjectChanged",
    "same_workspace_lineage",
  ]) assert.ok(value.workspaceBroker.includes(marker), `workspace.r.inspect lost ${marker}`);
  assert.doesNotMatch(
    value.workspaceBroker.split("#[cfg(test)]")[0],
    /workspace\.execute|rho_execute|function_source/,
    "workspace plugin inspection gained executable or source authority",
  );
  assert.match(value.rBridge, /bindingIsActive\(name, envir\)/);
  assert.match(value.rBridge, /Active bindings cannot be inspected without evaluating project code/);

  for (const marker of [
    ".https_only(true)",
    ".no_proxy()",
    ".redirect(reqwest::redirect::Policy::none())",
    ".referer(false)",
    ".resolve_to_addrs(&hop.host, &socket_addresses)",
    "MAX_PLUGIN_NETWORK_REDIRECTS: usize = 3",
    "PLUGIN_NETWORK_TIMEOUT: Duration = Duration::from_secs(15)",
    "addresses.iter().any(|address| !is_public_ip(*address))",
    "authorize(&authorization)",
    "filter_safe_header_map",
    "completion_uncertain",
  ]) assert.ok(value.networkBroker.includes(marker), `network.fetch lost ${marker}`);
  assert.doesNotMatch(
    value.networkBroker.split("#[cfg(test)]")[0],
    /danger_accept_invalid|cookie_store|["'](?:authorization|proxy-authorization)["']|\.proxy\(/i,
    "network broker gained credential, proxy, cookie, or invalid-TLS authority",
  );

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
    "invoke_workspace_plugin",
    "CoordinatorWorkspacePluginDispatcher",
    "issue_workspace_object_references",
    "invoke_network_plugin",
    "LiveNetworkAuthorizer",
    "completion_uncertain",
  ]) assert.ok(value.desktop.includes(marker), `desktop broker loop lost ${marker}`);
  for (const marker of [
    '"guest_abi_v2": 2',
    '"broker_yield_resume": true',
    '"grant_handle_bits": 256',
    '"raw_handle_redacted": true',
    '"revoke_enforced": true',
    '"durable_permission_lane": true',
    '"durable_raw_handle_absent": true',
  ]) assert.ok(value.desktop.includes(marker), `installed P2-2 smoke lost ${marker}`);
  const fileLoopStart = value.desktop.indexOf("invoke_plugin_with_hook");
  const fileLoop = fileLoopStart >= 0 ? value.desktop.slice(fileLoopStart) : value.desktop;
  assert.ok(
    fileLoop.indexOf("begin_broker_call") < fileLoop.indexOf("read_project_file("),
    "guest must yield before project file I/O",
  );
  assert.ok(
    fileLoop.indexOf("read_project_file(") < fileLoop.indexOf("resume_broker_call"),
    "project file I/O must finish before guest resume",
  );
}

function fixture() {
  return {
    host: "pub enum GuestStep\npub fn begin_broker_call\npub fn resume_broker_call\npub fn cancel_broker_call\nMAX_GUEST_BROKER_STEPS: usize = 8\nMAX_GUEST_STEP_BYTES: usize = 64 * 1024\nMAX_GUEST_BROKER_RESULT_BYTES: usize = 1024 * 1024\nmodule.imports().next().is_some()\nP2_2_SMOKE_WASM",
    grant: "rand::random()\npub trait GrantClock\npub trait GrantTokenSource\npub fn revalidate_admitted\npub fn durable_grant_id_for_handle\ncomplete_failure_before_dispatch\nWrongHostSession\nWrongPackageDigest\nWrongWorkspace",
    fileBroker: "pub fn read_project_file\nMAX_PLUGIN_FILE_READ_BYTES: u64 = 1024 * 1024\nsymlink_metadata\nis_link_or_reparse\nNestedRepository\ncanonical_file.starts_with(&canonical_root)\n.take(request.max_bytes + 1)\nafter_canonical_file != canonical_file\nGetFileInformationByHandle\nBY_HANDLE_FILE_INFORMATION\nFILE_FLAG_BACKUP_SEMANTICS\n.access_mode(FILE_READ_ATTRIBUTES)\n#[cfg(test)]",
    serverCargo: "[target.'cfg(windows)'.dependencies]\nwindows-sys = { version = \"0.60\", features = [\"Win32_Foundation\", \"Win32_Storage_FileSystem\"] }",
    workspaceBroker: 'pub struct WorkspaceObjectReferenceRegistry\nrequest_type: "workspace.inspect_object"\nMAX_WORKSPACE_METADATA_BYTES: usize = 64 * 1024\nMAX_WORKSPACE_PREVIEW_BYTES: usize = 256 * 1024\nMAX_WORKSPACE_PREVIEW_ROWS: usize = 100\nMAX_WORKSPACE_PREVIEW_COLUMNS: usize = 50\nMAX_WORKSPACE_PREVIEW_DEPTH: usize = 4\nObjectChanged\nsame_workspace_lineage\n#[cfg(test)]',
    rBridge: "bindingIsActive(name, envir)\nActive bindings cannot be inspected without evaluating project code",
    networkBroker: ".https_only(true)\n.no_proxy()\n.redirect(reqwest::redirect::Policy::none())\n.referer(false)\n.resolve_to_addrs(&hop.host, &socket_addresses)\nMAX_PLUGIN_NETWORK_REDIRECTS: usize = 3\nPLUGIN_NETWORK_TIMEOUT: Duration = Duration::from_secs(15)\naddresses.iter().any(|address| !is_public_ip(*address))\nauthorize(&authorization)\nfilter_safe_header_map\ncompletion_uncertain\n#[cfg(test)]",
    migration: "'call_admitted'\n'call_completed'\n'completion_uncertain'",
    store: "record_plugin_permission_call_event\nconsume_allow_once\nplugin permission call details contain a forbidden field",
    desktop: "invoke_plugin_with_hook\nbegin_broker_call\ncall_admitted\nread_project_file(\nrevalidate_admitted\ncall_completed\nstale_after_dispatch\nresume_broker_call\ninvoke_workspace_plugin\nCoordinatorWorkspacePluginDispatcher\nissue_workspace_object_references\ninvoke_network_plugin\nLiveNetworkAuthorizer\ncompletion_uncertain\n\"guest_abi_v2\": 2\n\"broker_yield_resume\": true\n\"grant_handle_bits\": 256\n\"raw_handle_redacted\": true\n\"revoke_enforced\": true\n\"durable_permission_lane\": true\n\"durable_raw_handle_absent\": true",
  };
}

if (process.argv.includes("--test")) {
  validateP22BrokerContract(fixture());
  for (const [name, mutate] of [
    ["WASI", (value) => { value.host += "\nwasmtime_wasi"; }],
    ["unbounded read", (value) => { value.fileBroker = value.fileBroker.replace(".take(request.max_bytes + 1)", ""); }],
    ["unstable Windows metadata identity", (value) => { value.fileBroker = value.fileBroker.replace("#[cfg(test)]", "metadata.volume_serial_number()\n#[cfg(test)]"); }],
    ["Windows directory identity", (value) => { value.fileBroker = value.fileBroker.replace("FILE_FLAG_BACKUP_SEMANTICS", ""); }],
    ["Windows least-privilege identity", (value) => { value.fileBroker = value.fileBroker.replace(".access_mode(FILE_READ_ATTRIBUTES)", ".read(true)"); }],
    ["Windows identity dependency", (value) => { value.serverCargo = value.serverCargo.replace("Win32_Storage_FileSystem", ""); }],
    ["no post-revoke check", (value) => { value.desktop = value.desktop.replace("revalidate_admitted", ""); }],
    ["active binding evaluation", (value) => { value.rBridge = value.rBridge.replace("bindingIsActive(name, envir)", ""); }],
    ["arbitrary R", (value) => { value.workspaceBroker = `workspace.execute\n${value.workspaceBroker}`; }],
    ["proxy inheritance", (value) => { value.networkBroker = value.networkBroker.replace(".no_proxy()", ""); }],
    ["private address check", (value) => { value.networkBroker = value.networkBroker.replace("addresses.iter().any(|address| !is_public_ip(*address))", ""); }],
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
    serverCargo: read("crates/rho-server/Cargo.toml"),
    workspaceBroker: read("crates/rho-server/src/plugin_workspace.rs"),
    rBridge: read("r/rho.bridge/R/workspace.R"),
    networkBroker: read("crates/rho-server/src/plugin_network.rs"),
    migration: read("crates/rho-store/src/migration.rs"),
    store: read("crates/rho-store/src/plugin_permission.rs"),
    desktop: `${read("desktop/src-tauri/src/workspace_plugins.rs")}\n${read("desktop/src-tauri/src/main.rs")}`,
  });
}

console.log("extension P2-2 broker contract passed");
