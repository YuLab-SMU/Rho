//! P2-0 adversarial discovery tests.
//!
//! Each test builds a temporary project root and asserts the discovery path
//! never executes code and never grants authority: malformed, oversized,
//! symlink-escaped, traversal, and duplicate packages all fail closed.

use std::fs;
use std::path::Path;

use rho_extension_runtime::discover_workspace_plugins;

/// Write a minimal valid manifest into `dir/rho-plugin.json`.
fn write_valid_manifest(dir: &Path, id: &str) {
    write_valid_manifest_in(dir, id, id);
}

fn write_valid_manifest_in(dir: &Path, directory: &str, id: &str) {
    let plugins = dir.join(".rho").join("plugins").join(directory);
    fs::create_dir_all(&plugins).unwrap();
    let manifest = format!(
        r#"{{
            "schemaVersion": 1,
            "id": "{id}",
            "name": "{id}",
            "version": "0.1.0",
            "apiVersion": "^1.0",
            "runtime": {{ "kind": "wasm", "entry": "dist/plugin.wasm", "scope": "project" }}
        }}"#
    );
    fs::write(plugins.join("rho-plugin.json"), manifest).unwrap();
    fs::create_dir_all(plugins.join("dist")).unwrap();
    fs::write(plugins.join("dist").join("plugin.wasm"), b"\0asm").unwrap();
}

fn temp_project() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn plugins_root(project: &Path) -> std::path::PathBuf {
    project.join(".rho").join("plugins")
}

#[test]
fn discovery_returns_none_when_plugins_dir_absent() {
    let project = temp_project();
    assert!(
        discover_workspace_plugins(project.path())
            .unwrap()
            .is_none()
    );
}

#[test]
fn discovery_finds_and_digests_a_valid_plugin_without_executing() {
    let project = temp_project();
    write_valid_manifest(project.path(), "org.example.one");
    // Also drop an executable-looking entry that is NOT declared by the manifest;
    // discovery must ignore it and never load it.
    fs::write(
        plugins_root(project.path())
            .join("org.example.one")
            .join("dist")
            .join("evil.sh"),
        "#!/bin/sh\necho pwned",
    )
    .unwrap();

    let report = discover_workspace_plugins(project.path())
        .unwrap()
        .expect("plugins dir exists");
    assert_eq!(report.plugins.len(), 1);
    assert!(report.failures.is_empty());
    let discovered = &report.plugins[0];
    assert_eq!(discovered.manifest.id.as_str(), "org.example.one");
    // The digest must be non-empty and stable.
    assert!(!discovered.digest.as_str().is_empty());
}

#[test]
fn discovery_rejects_symlink_plugin_directory() {
    let project = temp_project();
    write_valid_manifest(project.path(), "org.example.real");

    // A symlinked plugin directory pointing elsewhere must be rejected.
    let outside = temp_project();
    let link = plugins_root(project.path()).join("org.example.linked");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        // A symlink under `.rho/plugins` is a hard fail-closed condition: the
        // whole discovery returns an error rather than silently skipping it.
        let result = discover_workspace_plugins(project.path());
        assert!(result.is_err());
    }
}

#[test]
fn discovery_rejects_parent_traversal_manifest_entry() {
    let project = temp_project();
    let plugins = plugins_root(project.path()).join("org.example.trav");
    fs::create_dir_all(&plugins).unwrap();
    fs::write(
        plugins.join("rho-plugin.json"),
        r#"{
            "schemaVersion": 1,
            "id": "org.example.trav",
            "name": "Trav",
            "version": "0.1.0",
            "apiVersion": "^1.0",
            "runtime": { "kind": "wasm", "entry": "../etc/passwd", "scope": "project" }
        }"#,
    )
    .unwrap();

    let report = discover_workspace_plugins(project.path())
        .unwrap()
        .expect("plugins dir exists");
    assert!(report.failures.len() == 1);
}

#[test]
fn discovery_rejects_duplicate_plugin_ids() {
    let project = temp_project();
    write_valid_manifest_in(project.path(), "first", "org.example.dup");
    write_valid_manifest_in(project.path(), "second", "org.example.dup");

    let report = discover_workspace_plugins(project.path())
        .unwrap()
        .expect("plugins dir exists");
    assert_eq!(report.plugins.len(), 1);
    assert_eq!(report.failures.len(), 1);
    assert!(report.failures[0].reason.contains("duplicate plugin id"));
}

#[test]
fn discovery_rejects_missing_declared_entry() {
    let project = temp_project();
    write_valid_manifest(project.path(), "org.example.missing-entry");
    fs::remove_file(
        plugins_root(project.path())
            .join("org.example.missing-entry")
            .join("dist")
            .join("plugin.wasm"),
    )
    .unwrap();

    let report = discover_workspace_plugins(project.path())
        .unwrap()
        .expect("plugins dir exists");
    assert!(report.plugins.is_empty());
    assert_eq!(report.failures.len(), 1);
    assert!(
        report.failures[0]
            .reason
            .contains("runtime entry is missing")
    );
}

#[cfg(unix)]
#[test]
fn discovery_rejects_plugins_root_symlink_even_inside_project() {
    let project = temp_project();
    let real_plugins = project.path().join("real-plugins");
    fs::create_dir_all(project.path().join(".rho")).unwrap();
    fs::create_dir_all(&real_plugins).unwrap();
    std::os::unix::fs::symlink("../real-plugins", plugins_root(project.path())).unwrap();

    let result = discover_workspace_plugins(project.path());
    assert!(result.is_err());
}

#[test]
fn discovery_rejects_oversized_manifest() {
    let project = temp_project();
    let plugins = plugins_root(project.path()).join("org.example.big");
    fs::create_dir_all(&plugins).unwrap();
    let huge = "x".repeat(300 * 1024);
    fs::write(plugins.join("rho-plugin.json"), &huge).unwrap();

    let report = discover_workspace_plugins(project.path())
        .unwrap()
        .expect("plugins dir exists");
    assert_eq!(report.plugins.len(), 0);
    assert!(report.failures.len() == 1);
}

#[test]
fn discovery_rejects_missing_manifest() {
    let project = temp_project();
    let plugins = plugins_root(project.path()).join("org.example.nomanifest");
    fs::create_dir_all(&plugins).unwrap();
    fs::write(plugins.join("not-a-manifest.txt"), "hello").unwrap();

    let report = discover_workspace_plugins(project.path())
        .unwrap()
        .expect("plugins dir exists");
    assert!(report.failures.len() == 1);
}

#[test]
fn opening_an_unfamiliar_project_executes_no_code() {
    // A project whose plugins directory contains a manifest with an invalid
    // runtime kind must not run anything and must not surface a valid plugin.
    let project = temp_project();
    let plugins = plugins_root(project.path()).join("org.example.node");
    fs::create_dir_all(&plugins).unwrap();
    fs::write(
        plugins.join("rho-plugin.json"),
        r#"{
            "schemaVersion": 1,
            "id": "org.example.node",
            "name": "Node",
            "version": "0.1.0",
            "apiVersion": "^1.0",
            "runtime": { "kind": "node", "entry": "index.js", "scope": "project" }
        }"#,
    )
    .unwrap();

    let report = discover_workspace_plugins(project.path())
        .unwrap()
        .expect("plugins dir exists");
    assert!(report.plugins.is_empty());
    assert!(!report.failures.is_empty());
}
