use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use rho_plugin_dev::package_cache::PluginPackageCache;
use rho_plugin_dev::{
    build_project, check_project, compare_component, smoke_command, smoke_surface, smoke_tool,
    smoke_viewer, snapshot_component,
};

const PLUGIN_ID: &str = "org.yulab.rho.local-hello";
const COMMAND_ID: &str = "ui.command.local_hello";
const TOOL_ID: &str = "tool.local_status";
const VIEWER_ID: &str = "ui.viewer.local_status";
const SURFACE_PLUGIN_ID: &str = "org.yulab.rho.local-surface";
const SURFACE_ID: &str = "ui.surface.local_notes";

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

fn surface_example_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("examples/workspace-plugin-surface")
}

fn copied_surface_example() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    copy_tree(&surface_example_root(), directory.path());
    directory
}

fn plugin_path(project: &Path, relative: &str) -> PathBuf {
    project.join(".rho/plugins/local-hello").join(relative)
}

fn surface_plugin_path(project: &Path, relative: &str) -> PathBuf {
    project.join(".rho/plugins/local-surface").join(relative)
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
    assert_eq!(checked.plugins[0].contribution_count, 3);
    let original_digest = checked.plugins[0].digest.clone();

    let first = smoke_command(project.path(), PLUGIN_ID, COMMAND_ID).unwrap();
    let second = smoke_command(project.path(), PLUGIN_ID, COMMAND_ID).unwrap();
    let tool = smoke_tool(project.path(), PLUGIN_ID, TOOL_ID).unwrap();
    let viewer = smoke_viewer(project.path(), PLUGIN_ID, VIEWER_ID).unwrap();
    assert_eq!(first.guest_abi, 2);
    assert_eq!(first.result["kind"], "notification");
    assert_eq!(first.result["message"], "Rho local plugin is running");
    assert_eq!(second.result, first.result);
    assert_eq!(tool.digest, first.digest);
    assert_eq!(tool.result["component"], "local-hello");
    assert_eq!(tool.result["status"], "ready");
    assert_eq!(viewer.digest, first.digest);
    assert_eq!(viewer.result["contract"], "rho.plugin_viewer_document.v1");
    assert_eq!(viewer.result["blocks"][0]["kind"], "text");

    let wat_path = plugin_path(project.path(), "src/plugin.wat");
    writeln!(
        fs::OpenOptions::new().append(true).open(wat_path).unwrap(),
        ";; digest probe"
    )
    .unwrap();
    let changed = check_project(project.path()).unwrap();
    assert_ne!(changed.plugins[0].digest, original_digest);
    let evolved = build_project(project.path()).unwrap();
    assert_eq!(evolved.check.plugins[0].digest, changed.plugins[0].digest);
    assert_eq!(
        smoke_command(project.path(), PLUGIN_ID, COMMAND_ID)
            .unwrap()
            .digest,
        changed.plugins[0].digest
    );
    assert_eq!(
        smoke_tool(project.path(), PLUGIN_ID, TOOL_ID)
            .unwrap()
            .digest,
        changed.plugins[0].digest
    );
    assert_eq!(
        smoke_viewer(project.path(), PLUGIN_ID, VIEWER_ID)
            .unwrap()
            .digest,
        changed.plugins[0].digest
    );
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
    assert!(smoke_stdout.contains("kind=command"));
    assert!(smoke_stdout.contains("result_contract=notification"));
    assert!(!smoke_stdout.contains("Rho local plugin is running"));
    assert!(!smoke_stdout.contains("handle."));

    for (command, contribution, expected) in [
        (
            "smoke-tool",
            TOOL_ID,
            "result_contract=declared_output_schema",
        ),
        (
            "smoke-viewer",
            VIEWER_ID,
            "result_contract=rho.plugin_viewer_document.v1",
        ),
    ] {
        let output = Command::new(binary)
            .args([
                command,
                project.path().to_str().unwrap(),
                PLUGIN_ID,
                contribution,
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(stdout.contains("smoke_ok"));
        assert!(stdout.contains(expected));
        assert!(!stdout.contains("Rho local"));
        assert!(!stdout.contains("handle."));
    }

    let cache_root = tempfile::tempdir().unwrap();
    let snapshot = Command::new(binary)
        .args([
            "snapshot",
            project.path().to_str().unwrap(),
            PLUGIN_ID,
            cache_root.path().to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(snapshot.status.success());
    let snapshot_stdout = String::from_utf8(snapshot.stdout).unwrap();
    let baseline_digest = snapshot_stdout
        .split_whitespace()
        .find_map(|field| field.strip_prefix("digest="))
        .unwrap()
        .to_string();
    writeln!(
        fs::OpenOptions::new()
            .append(true)
            .open(plugin_path(project.path(), "src/plugin.wat"))
            .unwrap(),
        ";; CLI evolution candidate"
    )
    .unwrap();
    let build = Command::new(binary)
        .args(["build", project.path().to_str().unwrap()])
        .output()
        .unwrap();
    assert!(build.status.success());
    let compare = Command::new(binary)
        .args([
            "compare",
            project.path().to_str().unwrap(),
            PLUGIN_ID,
            cache_root.path().to_str().unwrap(),
            &baseline_digest,
        ])
        .output()
        .unwrap();
    assert!(compare.status.success());
    let compare_stdout = String::from_utf8(compare.stdout).unwrap();
    assert!(compare_stdout.contains("compare_ok"));
    assert!(compare_stdout.contains("surfaces=3"));
    assert!(compare_stdout.contains(&format!("baseline_digest={baseline_digest}")));
    assert!(!compare_stdout.contains("Rho local"));
    assert!(!compare_stdout.contains("handle."));
}

#[test]
fn manifest_v3_surface_build_check_and_two_instance_smoke_form_one_local_loop() {
    let project = copied_surface_example();
    let built = build_project(project.path()).unwrap();
    assert_eq!(built.built_plugins, vec![SURFACE_PLUGIN_ID]);
    assert_eq!(built.check.plugins.len(), 1);
    assert_eq!(built.check.plugins[0].contribution_count, 1);

    let checked = check_project(project.path()).unwrap();
    assert_eq!(checked.plugins[0].plugin_id, SURFACE_PLUGIN_ID);
    let smoke = smoke_surface(project.path(), SURFACE_PLUGIN_ID, SURFACE_ID).unwrap();
    assert_eq!(smoke.guest_abi, 2);
    assert_eq!(smoke.instances.len(), 2);
    assert_ne!(
        smoke.instances[0].instance_id,
        smoke.instances[1].instance_id
    );
    assert!(
        smoke
            .instances
            .iter()
            .all(|instance| instance.document_revision == 1
                && instance.block_count == 1
                && instance.control_count == 2)
    );

    let output = Command::new(env!("CARGO_BIN_EXE_rho-plugin-dev"))
        .args([
            "smoke-surface",
            project.path().to_str().unwrap(),
            SURFACE_PLUGIN_ID,
            SURFACE_ID,
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("surface_smoke_ok"));
    assert!(stdout.contains("instances=2"));
    assert_eq!(stdout.matches("surface_instance_ok").count(), 2);
    assert!(!stdout.contains("Independent plugin Surface instance"));
}

#[test]
fn surface_smoke_rejects_a_hostile_raw_html_document() {
    let project = copied_surface_example();
    let source_path = surface_plugin_path(project.path(), "src/plugin.wat");
    let source = fs::read_to_string(&source_path).unwrap();
    let hostile = source
        .replacen("\\22text\\22", "\\22raw_html\\22", 1)
        .replacen("i32.const 471", "i32.const 475", 1)
        .replacen("i64.const 522", "i64.const 526", 1);
    fs::write(source_path, hostile).unwrap();
    build_project(project.path()).unwrap();

    let error = smoke_surface(project.path(), SURFACE_PLUGIN_ID, SURFACE_ID).unwrap_err();
    assert_eq!(error.code(), "surface_document_rejected");
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
    let wrong_kind = copied_example();
    assert_eq!(
        smoke_tool(wrong_kind.path(), PLUGIN_ID, COMMAND_ID)
            .unwrap_err()
            .code(),
        "contribution_not_tool"
    );
    assert_eq!(
        smoke_viewer(wrong_kind.path(), PLUGIN_ID, TOOL_ID)
            .unwrap_err()
            .code(),
        "contribution_not_viewer"
    );

    let stale_tool_schema = copied_example();
    let mut value = manifest(stale_tool_schema.path());
    value["contributions"][1]["outputSchema"]["properties"]["status"]["enum"] =
        serde_json::json!(["stale"]);
    write_manifest(stale_tool_schema.path(), &value);
    assert_eq!(
        smoke_tool(stale_tool_schema.path(), PLUGIN_ID, TOOL_ID)
            .unwrap_err()
            .code(),
        "output_schema_rejected"
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

#[test]
fn immutable_baseline_and_evolved_candidate_both_keep_all_surfaces_callable() {
    let project = copied_example();
    let cache_root = tempfile::tempdir().unwrap();
    let baseline = snapshot_component(project.path(), PLUGIN_ID, cache_root.path()).unwrap();
    let baseline_entry = fs::read(plugin_path(project.path(), "dist/plugin.wasm")).unwrap();
    assert_eq!(
        compare_component(
            project.path(),
            PLUGIN_ID,
            cache_root.path(),
            &baseline.digest,
        )
        .unwrap_err()
        .code(),
        "candidate_unchanged"
    );

    writeln!(
        fs::OpenOptions::new()
            .append(true)
            .open(plugin_path(project.path(), "src/plugin.wat"))
            .unwrap(),
        ";; evolved component candidate"
    )
    .unwrap();
    let candidate = build_project(project.path()).unwrap();
    assert_ne!(candidate.check.plugins[0].digest, baseline.digest);
    let compared = compare_component(
        project.path(),
        PLUGIN_ID,
        cache_root.path(),
        &baseline.digest,
    )
    .unwrap();
    assert_eq!(compared.baseline_digest, baseline.digest);
    assert_eq!(compared.candidate_digest, candidate.check.plugins[0].digest);
    assert_eq!(compared.validated_surfaces, 3);

    let canonical = project.path().canonicalize().unwrap();
    let cached = PluginPackageCache::new(cache_root.path())
        .load_exact(
            canonical.to_string_lossy().as_ref(),
            PLUGIN_ID,
            &baseline.digest,
        )
        .unwrap();
    assert_eq!(
        cached.file_bytes("dist/plugin.wasm").unwrap(),
        baseline_entry
    );
    assert_ne!(
        cached.file_bytes("src/plugin.wat").unwrap(),
        fs::read(plugin_path(project.path(), "src/plugin.wat"))
            .unwrap()
            .as_slice()
    );
}

#[test]
fn compare_rejects_unknown_baseline_surface_drift_and_invalid_candidate() {
    let unknown = copied_example();
    let cache_root = tempfile::tempdir().unwrap();
    snapshot_component(unknown.path(), PLUGIN_ID, cache_root.path()).unwrap();
    fs::write(
        plugin_path(unknown.path(), "dist/plugin.wasm"),
        b"candidate change",
    )
    .unwrap();
    assert_eq!(
        compare_component(
            unknown.path(),
            PLUGIN_ID,
            cache_root.path(),
            &"a".repeat(64),
        )
        .unwrap_err()
        .code(),
        "baseline_load_failed"
    );

    let drift = copied_example();
    let cache_root = tempfile::tempdir().unwrap();
    let baseline = snapshot_component(drift.path(), PLUGIN_ID, cache_root.path()).unwrap();
    let mut value = manifest(drift.path());
    value["provides"].as_array_mut().unwrap().pop();
    value["contributions"].as_array_mut().unwrap().pop();
    write_manifest(drift.path(), &value);
    assert_eq!(
        compare_component(drift.path(), PLUGIN_ID, cache_root.path(), &baseline.digest,)
            .unwrap_err()
            .code(),
        "surface_drift"
    );

    let invalid = copied_example();
    let cache_root = tempfile::tempdir().unwrap();
    let baseline = snapshot_component(invalid.path(), PLUGIN_ID, cache_root.path()).unwrap();
    fs::write(plugin_path(invalid.path(), "dist/plugin.wasm"), b"\0asm").unwrap();
    assert_eq!(
        compare_component(
            invalid.path(),
            PLUGIN_ID,
            cache_root.path(),
            &baseline.digest,
        )
        .unwrap_err()
        .code(),
        "wasm_rejected"
    );

    let unsupported = copied_example();
    let cache_root = tempfile::tempdir().unwrap();
    let baseline = snapshot_component(unsupported.path(), PLUGIN_ID, cache_root.path()).unwrap();
    let mut value = manifest(unsupported.path());
    value["provides"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "capability": "skill.local_guide",
            "contract_major": 1
        }));
    value["contributions"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "id": "skill.local_guide",
            "kind": "skill",
            "contractMajor": 1,
            "label": "Local guide",
            "purpose": "Guide the local component",
            "skillPath": "skills/guide.md"
        }));
    write_manifest(unsupported.path(), &value);
    fs::create_dir_all(plugin_path(unsupported.path(), "skills")).unwrap();
    fs::write(
        plugin_path(unsupported.path(), "skills/guide.md"),
        "Local component guidance.",
    )
    .unwrap();
    assert_eq!(
        compare_component(
            unsupported.path(),
            PLUGIN_ID,
            cache_root.path(),
            &baseline.digest,
        )
        .unwrap_err()
        .code(),
        "unsupported_evolution_surface"
    );
}

#[cfg(unix)]
#[test]
fn snapshot_rejects_a_symlinked_broker_cache_root() {
    use std::os::unix::fs::symlink;

    let project = copied_example();
    let cache_root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(
        outside.path(),
        cache_root.path().join("plugin-package-cache"),
    )
    .unwrap();
    assert_eq!(
        snapshot_component(project.path(), PLUGIN_ID, cache_root.path())
            .unwrap_err()
            .code(),
        "cache_prepare_failed"
    );
    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());

    let project_cache = project.path().join(".plugin-dev-cache");
    fs::create_dir(&project_cache).unwrap();
    assert_eq!(
        snapshot_component(project.path(), PLUGIN_ID, &project_cache)
            .unwrap_err()
            .code(),
        "cache_root_rejected"
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
