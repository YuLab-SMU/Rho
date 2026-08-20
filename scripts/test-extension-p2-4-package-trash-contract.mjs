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
    "snapshot_workspace_plugin_package",
    "snapshot_workspace_plugin_cache_directory",
    "fs::rename",
    "source and trash both exist",
    "TrashFailurePoint::BeforeRename",
    "TrashFailurePoint::AfterRename",
    "move_restore_and_replays_are_exact_and_idempotent",
    "symlinked_trash_root_and_restore_collision_are_rejected",
  ]) assert.ok(value.trash.includes(marker), `recoverable package move lost ${marker}`);
  assert.doesNotMatch(
    value.trash.split("#[cfg(test)]")[0],
    /remove_dir_all|remove_file|reqwest|Command::new|GrantStore|WasmPluginHost|tauri::|rusqlite/,
    "D1 gained delete, network, process, grant, Wasm, Tauri, or Store authority",
  );
  assert.match(value.server, /pub mod plugin_package_trash/);
  assert.match(value.spec, /Active work package: none at the P2-4D1 checkpoint/);
  assert.match(value.spec, /P2-4D1 local checkpoint — 2026-08-20/);
}

function fixture() {
  return {
    trash: "PLUGIN_TRASH_DIRECTORY\nPluginPackageOwnershipOutcome\nPluginPackageMoveEvidence\npub fn move_exact(\npub fn restore_exact(\nsnapshot_workspace_plugin_package\nsnapshot_workspace_plugin_cache_directory\nfs::rename\nsource and trash both exist\nTrashFailurePoint::BeforeRename\nTrashFailurePoint::AfterRename\nmove_restore_and_replays_are_exact_and_idempotent\nsymlinked_trash_root_and_restore_collision_are_rejected\n#[cfg(test)]",
    server: "pub mod plugin_package_trash;",
    spec: "Active work package: none at the P2-4D1 checkpoint\nP2-4D1 local checkpoint — 2026-08-20",
  };
}

if (process.argv.includes("--test")) {
  validateP24PackageTrashContract(fixture());
  for (const [name, mutate] of [
    ["atomic rename", (value) => { value.trash = value.trash.replace("fs::rename", ""); }],
    ["exact readback", (value) => { value.trash = value.trash.replace("snapshot_workspace_plugin_cache_directory", ""); }],
    ["failure injection", (value) => { value.trash = value.trash.replace("TrashFailurePoint::AfterRename", ""); }],
    ["delete authority", (value) => { value.trash = `remove_dir_all\n${value.trash}`; }],
    ["checkpoint", (value) => { value.spec = value.spec.replace("P2-4D1 local checkpoint", ""); }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateP24PackageTrashContract(value), undefined, name);
  }
} else {
  validateP24PackageTrashContract({
    trash: read("crates/rho-server/src/plugin_package_trash.rs"),
    server: read("crates/rho-server/src/lib.rs"),
    spec: read("docs/plans/active-2026-08-20-p2-4-plugin-lifecycle-recovery-upgrade-spec.md"),
  });
}

console.log("extension P2-4 recoverable package move contract passed");
