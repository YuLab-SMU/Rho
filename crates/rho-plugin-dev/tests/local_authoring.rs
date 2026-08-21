use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use rho_plugin_dev::{build_project, check_project, smoke_command};

const PLUGIN_ID: &str = "org.yulab.rho.local-hello";
const COMMAND_ID: &str = "ui.command.local_hello";

fn example_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("examples/workspace-plugin-minimal")
}

fn copied_example() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    copy_tree(&example_root(), directory.path());
    directory
}

fn plugin_path(project: &Path, relative: &str) -> PathBuf {
    project.join(".rho/plugins/local-hello").join(relative)
}

fn copy_tree(source: &Path, target: &Path) {
    fs::create_dir_all(target).unwrap();
    let mut entries = fs::read_dir(source)
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let metadata = fs::symlink_metadata(entry.path()).unwrap();
        assert!(!metadata.file_type().is_symlink());
        let destination = target.join(entry.file_name());
        if metadata.is_dir() {
            copy_tree(&entry.path(), &destination);
        } else {
            fs::copy(entry.path(), destination).unwrap();
        }
    }
}

fn manifest(project: &Path) -> serde_json::Value {
    serde_json::from_slice(&fs::read(plugin_path(project, "rho-plugin.json")).unwrap()).unwrap()
}

fn write_manifest(project: &Path, value: &serde_json::Value) {
    fs::write(
        plugin_path(project, "rho-plugin.json"),
        serde_json::to_vec_pretty(value).unwrap(),
    )
    .unwrap();
}

#[test]
fn example_build_check_and_dynamic_command_smoke_form_one_local_loop() {
    let project = copied_example();
    let checked_in_wasm = fs::read(plugin_path(&example_root(), "dist/plugin.wasm")).unwrap();

    let built = build_project(project.path()).unwrap();
    assert_eq!(built.built_plugins, vec![PLUGIN_ID]);
    assert_eq!(built.check.plugins.len(), 1);
    assert_eq!(
        fs::read(plugin_path(project.path(), "dist/plugin.wasm")).unwrap(),
        checked_in_wasm
    );

    let checked = check_project(project.path()).unwrap();
    assert_eq!(checked.plugins[0].plugin_id, PLUGIN_ID);
    assert_eq!(checked.plugins[0].contribution_count, 1);
    let original_digest = checked.plugins[0].digest.clone();

    let first = smoke_command(project.path(), PLUGIN_ID, COMMAND_ID).unwrap();
    let second = smoke_command(project.path(), PLUGIN_ID, COMMAND_ID).unwrap();
    assert_eq!(first.guest_abi, 2);
    assert_eq!(first.result["kind"], "notification");
    assert_eq!(first.result["message"], "Rho local plugin is running");
    assert_eq!(second.result, first.result);

    let wat_path = plugin_path(project.path(), "src/plugin.wat");
    writeln!(
        fs::OpenOptions::new().append(true).open(wat_path).unwrap(),
        ";; digest probe"
    )
    .unwrap();
    let changed = check_project(project.path()).unwrap();
    assert_ne!(changed.plugins[0].digest, original_digest);
}

#[test]
fn cli_reports_the_same_checked_and_smoked_package() {
    let project = copied_example();
    let binary = env!("CARGO_BIN_EXE_rho-plugin-dev");
    let check = Command::new(binary)
        .args(["check", project.path().to_str().unwrap()])
        .output()
        .unwrap();
    assert!(check.status.success());
    let check_stdout = String::from_utf8(check.stdout).unwrap();
    assert!(check_stdout.contains("check_ok"));
    assert!(check_stdout.contains(PLUGIN_ID));
    assert!(!check_stdout.contains("handle."));

    let smoke = Command::new(binary)
        .args([
            "smoke-command",
            project.path().to_str().unwrap(),
            PLUGIN_ID,
            COMMAND_ID,
        ])
        .output()
        .unwrap();
    assert!(smoke.status.success());
    let smoke_stdout = String::from_utf8(smoke.stdout).unwrap();
    assert!(smoke_stdout.contains("smoke_ok"));
    assert!(smoke_stdout.contains("result_kind=notification"));
    assert!(!smoke_stdout.contains("Rho local plugin is running"));
    assert!(!smoke_stdout.contains("handle."));
}

#[test]
fn unknown_manifest_and_malformed_wasm_fail_with_actionable_codes() {
    let unknown = copied_example();
    let mut value = manifest(unknown.path());
    value["ambientAuthority"] = serde_json::json!(true);
    write_manifest(unknown.path(), &value);
    let error = check_project(unknown.path()).unwrap_err();
    assert_eq!(error.code(), "discovery_rejected");
    assert!(error.message().contains("unknown field"));

    let malformed = copied_example();
    fs::write(plugin_path(malformed.path(), "dist/plugin.wasm"), b"\0asm").unwrap();
    assert!(check_project(malformed.path()).is_ok());
    let error = smoke_command(malformed.path(), PLUGIN_ID, COMMAND_ID).unwrap_err();
    assert_eq!(error.code(), "wasm_rejected");
    assert!(error.message().contains("invalid_module"));

    let imported = copied_example();
    let imported_wasm = wat::parse_str(
        r#"(module
            (import "wasi_snapshot_preview1" "fd_write" (func))
            (memory (export "memory") 1 1)
            (func (export "rho_activate") (param i32) (result i32) i32.const 0)
            (func (export "rho_echo") (param i32 i32) (result i64) i64.const 0)
            (func (export "rho_heartbeat") (result i32) i32.const 0)
            (func (export "rho_quiesce") (result i32) i32.const 0)
            (func (export "rho_dispose") (result i32) i32.const 0)
            (func (export "rho_begin") (param i32 i32) (result i64) i64.const 0)
            (func (export "rho_resume") (param i32 i32) (result i64) i64.const 0)
            (func (export "rho_cancel") (param i32 i32) (result i32) i32.const 0))"#,
    )
    .unwrap();
    fs::write(
        plugin_path(imported.path(), "dist/plugin.wasm"),
        imported_wasm,
    )
    .unwrap();
    let error = smoke_command(imported.path(), PLUGIN_ID, COMMAND_ID).unwrap_err();
    assert_eq!(error.code(), "wasm_rejected");
    assert!(error.message().contains("forbidden_import"));
}

#[test]
fn build_rejects_missing_source_and_smoke_rejects_permissions() {
    let missing = copied_example();
    fs::remove_file(plugin_path(missing.path(), "src/plugin.wat")).unwrap();
    assert_eq!(
        build_project(missing.path()).unwrap_err().code(),
        "no_wat_sources"
    );

    let permissioned = copied_example();
    let mut value = manifest(permissioned.path());
    value["permissions"] = serde_json::json!([{
        "name": "project.fs.read",
        "paths": ["data/*.csv"],
        "maxBytes": 1024
    }]);
    write_manifest(permissioned.path(), &value);
    assert!(check_project(permissioned.path()).is_ok());
    assert_eq!(
        smoke_command(permissioned.path(), PLUGIN_ID, COMMAND_ID)
            .unwrap_err()
            .code(),
        "permissions_not_supported"
    );

    let unknown = copied_example();
    assert_eq!(
        smoke_command(unknown.path(), PLUGIN_ID, "ui.command.missing")
            .unwrap_err()
            .code(),
        "contribution_not_found"
    );

    let not_command = copied_example();
    let mut value = manifest(not_command.path());
    value["provides"][0]["capability"] = serde_json::json!("tool.local_hello");
    value["contributions"][0]["id"] = serde_json::json!("tool.local_hello");
    value["contributions"][0]["kind"] = serde_json::json!("tool");
    write_manifest(not_command.path(), &value);
    assert!(check_project(not_command.path()).is_ok());
    assert_eq!(
        smoke_command(not_command.path(), PLUGIN_ID, "tool.local_hello")
            .unwrap_err()
            .code(),
        "contribution_not_command"
    );
}

#[test]
fn failed_or_interrupted_build_preserves_the_previous_entry_and_recovers() {
    let invalid = copied_example();
    let entry = plugin_path(invalid.path(), "dist/plugin.wasm");
    let accepted = fs::read(&entry).unwrap();
    fs::write(
        plugin_path(invalid.path(), "src/plugin.wat"),
        "(module broken",
    )
    .unwrap();
    assert_eq!(
        build_project(invalid.path()).unwrap_err().code(),
        "wat_compile_failed"
    );
    assert_eq!(fs::read(&entry).unwrap(), accepted);
    assert!(
        !entry
            .parent()
            .unwrap()
            .join(".plugin.wasm.rho-plugin-dev.partial")
            .exists()
    );

    let interrupted = copied_example();
    let entry = plugin_path(interrupted.path(), "dist/plugin.wasm");
    let partial = entry
        .parent()
        .unwrap()
        .join(".plugin.wasm.rho-plugin-dev.partial");
    fs::write(&partial, b"previous interrupted build").unwrap();
    assert_eq!(
        build_project(interrupted.path()).unwrap_err().code(),
        "entry_write_failed"
    );
    assert!(partial.exists());
    fs::remove_file(partial).unwrap();
    assert!(build_project(interrupted.path()).is_ok());
    assert!(smoke_command(interrupted.path(), PLUGIN_ID, COMMAND_ID).is_ok());
}

#[test]
fn build_leaves_valid_binary_only_plugins_unchanged() {
    let project = copied_example();
    let binary_only = project.path().join(".rho/plugins/binary-only-local-hello");
    copy_tree(
        &project.path().join(".rho/plugins/local-hello"),
        &binary_only,
    );
    fs::remove_file(binary_only.join("src/plugin.wat")).unwrap();
    fs::remove_dir(binary_only.join("src")).unwrap();
    let manifest_path = binary_only.join("rho-plugin.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    value["id"] = serde_json::json!("org.yulab.rho.binary-only-hello");
    value["name"] = serde_json::json!("Binary-only hello");
    value["provides"][0]["capability"] = serde_json::json!("ui.command.binary_only_hello");
    value["contributions"][0]["id"] = serde_json::json!("ui.command.binary_only_hello");
    fs::write(&manifest_path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    let binary_before = fs::read(binary_only.join("dist/plugin.wasm")).unwrap();

    let report = build_project(project.path()).unwrap();
    assert_eq!(report.built_plugins, vec![PLUGIN_ID]);
    assert_eq!(report.check.plugins.len(), 2);
    assert_eq!(
        fs::read(binary_only.join("dist/plugin.wasm")).unwrap(),
        binary_before
    );
}

#[cfg(unix)]
#[test]
fn build_never_writes_through_a_symlinked_entry_directory() {
    use std::os::unix::fs::symlink;

    let project = copied_example();
    let dist = plugin_path(project.path(), "dist");
    fs::remove_file(dist.join("plugin.wasm")).unwrap();
    fs::remove_dir(&dist).unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), &dist).unwrap();
    let error = build_project(project.path()).unwrap_err();
    assert_eq!(error.code(), "entry_path_rejected");
    assert!(!outside.path().join("plugin.wasm").exists());
}
