use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};

fn run(root: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_rho"))
        .args([
            "--database",
            root.join("science-must-not-exist.sqlite3")
                .to_str()
                .unwrap(),
            "plugins",
            "--store",
            root.join("plugins").to_str().unwrap(),
        ])
        .args(args)
        .output()
        .unwrap()
}
fn result(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice::<Value>(&output.stdout).unwrap()["result"].clone()
}

#[test]
fn recovery_cli_observes_empty_store_without_starting_science_or_creating_storage() {
    let temp = tempfile::tempdir().unwrap();
    assert_eq!(
        result(run(temp.path(), &["list"])),
        serde_json::json!({"revisions":[],"next":null,"total":0})
    );
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
    assert_eq!(result(run(temp.path(), &["instances"])), serde_json::json!({
        "recorded":{"instances":[],"next":null,"total":0},"live_verified":false
    }));
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
}

#[test]
fn package_cli_round_trip_works_without_a_project_or_scientific_host() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/example-inspector");
    let installed = result(run(temp.path(), &["snapshot", fixture.to_str().unwrap()]));
    let revision = installed["revision"].as_str().unwrap();
    assert_eq!(installed["plugin"], "example.inspector");
    let archive = temp.path().join("inspector.rho-plugin");
    result(run(
        temp.path(),
        &["export", revision, archive.to_str().unwrap()],
    ));
    result(run(temp.path(), &["remove", revision]));
    assert_eq!(
        result(run(temp.path(), &["list"])),
        serde_json::json!({"revisions":[],"next":null,"total":0})
    );
    let restored = result(run(temp.path(), &["import", archive.to_str().unwrap()]));
    assert_eq!(restored, installed);
    assert!(!temp.path().join("science-must-not-exist.sqlite3").exists());
    assert!(!temp.path().join(".rho").exists());
}

#[test]
fn default_repository_follows_configured_database_without_creating_a_host() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("state/science.sqlite");
    let run = |args: &[&str]| Command::new(env!("CARGO_BIN_EXE_rho"))
        .args(["--database", database.to_str().unwrap(), "plugins"])
        .args(args).output().unwrap();
    assert_eq!(result(run(&["list"]))["total"], 0);
    assert!(!database.parent().unwrap().exists());
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/example-inspector");
    result(run(&["snapshot", fixture.to_str().unwrap()]));
    assert_eq!(result(run(&["list"]))["total"], 1);
    assert!(database.parent().unwrap().join("plugins-v1/catalog-v1.sqlite3").exists());
    assert!(!database.exists());
}
