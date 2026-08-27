import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

export function validateP24PackageTrashContract(value) {
  for (const marker of [
    "PLUGIN_TRASH_DIRECTORY",
    "PluginPackageOwnershipOutcome",
    "PluginPackageMoveEvidence",
    "pub fn move_exact(",
    "pub fn restore_exact(",
    "pub fn purge_exact(",
    "snapshot_workspace_plugin_package",
    "snapshot_workspace_plugin_cache_directory",
    "fs::rename",
    "source and trash both exist",
    "TrashFailurePoint::BeforeRename",
    "TrashFailurePoint::AfterRename",
    "TrashFailurePoint::BeforePurgeRename",
    "TrashFailurePoint::AfterPurgeRename",
    "TrashFailurePoint::MidPurgeDelete",
    "TrashFailurePoint::AfterPurgeDelete",
    "move_restore_and_replays_are_exact_and_idempotent",
    "symlinked_trash_root_and_restore_collision_are_rejected",
    "exact_purge_is_bounded_idempotent_and_preserves_siblings",
    "purge_interruptions_recover_from_exact_marker_and_ownership",
  ]) assert.ok(value.trash.includes(marker), `recoverable package move lost ${marker}`);
  assert.doesNotMatch(
    value.trash.split("#[cfg(test)]")[0],
    /reqwest|Command::new|GrantStore|WasmPluginHost|tauri::|rusqlite/,
    "package ownership module gained network, process, grant, Wasm, Tauri, or Store authority",
  );
  assert.match(value.server, /pub mod plugin_package_trash/);
  assert.match(value.serverCargo, /rho-extension-runtime\s*=\s*\{\s*path/);
}

function fixture() {
  return {
    trash: "PLUGIN_TRASH_DIRECTORY\nPluginPackageOwnershipOutcome\nPluginPackageMoveEvidence\npub fn move_exact(\npub fn restore_exact(\npub fn purge_exact(\nsnapshot_workspace_plugin_package\nsnapshot_workspace_plugin_cache_directory\nfs::rename\nsource and trash both exist\nTrashFailurePoint::BeforeRename\nTrashFailurePoint::AfterRename\nTrashFailurePoint::BeforePurgeRename\nTrashFailurePoint::AfterPurgeRename\nTrashFailurePoint::MidPurgeDelete\nTrashFailurePoint::AfterPurgeDelete\nmove_restore_and_replays_are_exact_and_idempotent\nsymlinked_trash_root_and_restore_collision_are_rejected\nexact_purge_is_bounded_idempotent_and_preserves_siblings\npurge_interruptions_recover_from_exact_marker_and_ownership\n#[cfg(test)]",
    server: "pub mod plugin_package_trash;",
    serverCargo: 'rho-extension-runtime = { path = "../rho-extension-runtime" }',
  };
}

if (process.argv.includes("--test")) {
  validateP24PackageTrashContract(fixture());
  for (const [name, mutate] of [
    ["atomic rename", (value) => { value.trash = value.trash.replace("fs::rename", ""); }],
    ["exact readback", (value) => { value.trash = value.trash.replace("snapshot_workspace_plugin_cache_directory", ""); }],
    ["failure injection", (value) => { value.trash = value.trash.replace("TrashFailurePoint::AfterRename", ""); }],
    ["ambient network", (value) => { value.trash = `reqwest::get\n${value.trash}`; }],
    ["purge recovery", (value) => { value.trash = value.trash.replace("purge_interruptions_recover_from_exact_marker_and_ownership", ""); }],
    ["server export", (value) => { value.server = value.server.replace("pub mod plugin_package_trash", ""); }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateP24PackageTrashContract(value), undefined, name);
  }
} else {
  validateP24PackageTrashContract({
    trash: read("crates/rho-server/src/plugin_package_trash.rs"),
    server: read("crates/rho-server/src/lib.rs"),
    serverCargo: read("crates/rho-server/Cargo.toml"),
  });
}

console.log("extension P2-4 recoverable package move contract passed");
