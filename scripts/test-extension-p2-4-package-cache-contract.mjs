import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validateP24PackageCacheContract(value) {
  for (const marker of [
    "WorkspacePluginPackageSnapshot",
    "WorkspacePluginPackageFile",
    "snapshot_workspace_plugin_package",
    "snapshot_workspace_plugin_cache_directory",
    "plugin package changed while its exact snapshot was read",
    "package snapshot digest does not match expected identity",
  ]) assert.ok(value.discovery.includes(marker), `exact package snapshot lost ${marker}`);
  assert.doesNotMatch(
    value.discovery.split("#[cfg(test)]")[0],
    /fs::write|fs::rename|fs::remove|create_dir|OpenOptions|reqwest|Command::new|tauri::/,
    "read-only package snapshot gained mutation, network, process, or Tauri authority",
  );

  for (const marker of [
    "PLUGIN_PACKAGE_CACHE_DIRECTORY",
    "MAX_CACHED_PLUGIN_DIGESTS",
    "MAX_PROJECT_PLUGIN_CACHE_BYTES",
    "MAX_PACKAGE_AGGREGATE_BYTES",
    "snapshot_workspace_plugin_package",
    "snapshot_workspace_plugin_cache_directory",
    "prepare_exact",
    "load_exact",
    "create_new(true)",
    "sync_all()",
    "fs::rename",
    "inspect_project_cache",
    "make_tree_read_only",
    "cleanup_temporary",
    "CacheFailurePoint::AfterFirstFile",
    "CacheFailurePoint::BeforeRename",
    "CacheFailurePoint::AfterRename",
  ]) assert.ok(value.cache.includes(marker), `broker package cache lost ${marker}`);
  assert.doesNotMatch(
    value.cache.split("#[cfg(test)]")[0],
    /reqwest|Command::new|Credential|GrantStore|WasmPluginHost|tauri::|workspace\.r\./,
    "package cache gained network, process, credential, grant, Wasm, Tauri, or Workspace authority",
  );
  assert.match(value.serverCargo, /rho-extension-runtime\s*=\s*\{\s*path/);
  assert.match(value.serverLib, /pub mod plugin_package_cache/);
}

function fixture() {
  return {
    discovery: "WorkspacePluginPackageSnapshot\nWorkspacePluginPackageFile\nsnapshot_workspace_plugin_package\nsnapshot_workspace_plugin_cache_directory\nplugin package changed while its exact snapshot was read\npackage snapshot digest does not match expected identity\n#[cfg(test)]",
    cache: "PLUGIN_PACKAGE_CACHE_DIRECTORY\nMAX_CACHED_PLUGIN_DIGESTS\nMAX_PROJECT_PLUGIN_CACHE_BYTES\nMAX_PACKAGE_AGGREGATE_BYTES\nsnapshot_workspace_plugin_package\nsnapshot_workspace_plugin_cache_directory\nprepare_exact\nload_exact\ncreate_new(true)\nsync_all()\nfs::rename\ninspect_project_cache\nmake_tree_read_only\ncleanup_temporary\nCacheFailurePoint::AfterFirstFile\nCacheFailurePoint::BeforeRename\nCacheFailurePoint::AfterRename\n#[cfg(test)]",
    serverCargo: 'rho-extension-runtime = { path = "../rho-extension-runtime" }',
    serverLib: "pub mod plugin_package_cache;",
  };
}

if (process.argv.includes("--test")) {
  validateP24PackageCacheContract(fixture());
  for (const [name, mutate] of [
    ["digest readback", (value) => { value.discovery = value.discovery.replace("package snapshot digest does not match expected identity", ""); }],
    ["atomic rename", (value) => { value.cache = value.cache.replace("fs::rename", ""); }],
    ["cache bounds", (value) => { value.cache = value.cache.replace("MAX_PROJECT_PLUGIN_CACHE_BYTES", ""); }],
    ["ambient network", (value) => { value.cache = `reqwest::get\n${value.cache}`; }],
    ["runtime dependency", (value) => { value.serverCargo = value.serverCargo.replace("rho-extension-runtime", ""); }],
    ["server export", (value) => { value.serverLib = value.serverLib.replace("pub mod plugin_package_cache", ""); }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateP24PackageCacheContract(value), undefined, name);
  }
} else {
  validateP24PackageCacheContract({
    discovery: read("crates/rho-extension-runtime/src/discovery.rs"),
    cache: read("crates/rho-server/src/plugin_package_cache.rs"),
    serverCargo: read("crates/rho-server/Cargo.toml"),
    serverLib: read("crates/rho-server/src/lib.rs"),
  });
}

console.log("extension P2-4 exact package cache contract passed");
