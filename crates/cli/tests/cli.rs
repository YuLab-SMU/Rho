use serde_json::{Value, json};
use std::process::Command;

#[test]
fn independent_cli_processes_reuse_durable_operation_and_query_without_writes() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("next.sqlite");
    let project = dir.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let invoke = |name: &str| {
        Command::new(env!("CARGO_BIN_EXE_rho"))
            .arg("--project").arg(&project)
            .arg("--database")
            .arg(&db)
            .args(["invoke", "--client-request-id", "cli-once", "--capability", "scenarios.checkpoint", "--arguments"])
            .arg(json!({"scenario":"cli", "expected_head":null, "name":name, "instances":{}, "providers":[], "layout":{"kind":"empty"}}).to_string())
            .output()
            .unwrap()
    };
    let first = invoke("First");
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let value: Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(value["operation"]["status"], json!("succeeded"));
    assert_eq!(value["runtime"], json!("plugins"));
    let repeat = invoke("First");
    let repeated: Value = serde_json::from_slice(&repeat.stdout).unwrap();
    assert_eq!(repeated, value);
    let conflict = invoke("Changed");
    assert!(!conflict.status.success());
    let conflict: Value = serde_json::from_slice(&conflict.stderr).unwrap();
    // The scenario owner rejects the stale expected head before admitting a changed request.
    assert_eq!(conflict["diagnostic"]["code"], "content_changed");

    let before = std::fs::read(&db).unwrap();
    let query = Command::new(env!("CARGO_BIN_EXE_rho"))
        .arg("--database")
        .arg(&db)
        .args([
            "get-operation",
            value["operation"]["operation"]["operation_id"]
                .as_str()
                .unwrap(),
        ])
        .output()
        .unwrap();
    assert!(query.status.success());
    let queried: Value = serde_json::from_slice(&query.stdout).unwrap();
    // The durable result is identical; the journal-only reader advertises only available queries.
    let mut original_record = value["operation"].clone();
    let mut queried_record = queried["operation"].clone();
    let _original_reads = original_record
        .as_object_mut()
        .unwrap()
        .remove("next_reads")
        .unwrap();
    let queried_reads = queried_record
        .as_object_mut()
        .unwrap()
        .remove("next_reads")
        .unwrap();
    assert_eq!(queried_record, original_record);
    assert_eq!(queried_reads.as_array().unwrap().len(), 1);
    assert_eq!(queried_reads[0]["capability"]["id"], "operation.get");
    assert_eq!(
        queried_reads[0]["arguments"]["operation_id"],
        original_record["operation"]["operation_id"]
    );
    assert_eq!(before, std::fs::read(&db).unwrap());
}

#[test]
fn missing_scientific_plugins_never_fall_back_to_fixed_owners() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    std::fs::create_dir(&project).unwrap();
    std::fs::write(project.join("analysis.R"), "original\n").unwrap();
    for (capability, arguments) in [
        (
            "workspace.run_r",
            json!({"code":"writeLines('effect', 'produced.txt')"}),
        ),
        (
            "project.apply_patch",
            json!({"patch":"--- a/analysis.R\n+++ b/analysis.R\n@@ -1 +1 @@\n-original\n+changed\n"}),
        ),
        (
            "process.run_local",
            json!({"program":"must-not-start", "args":[]}),
        ),
    ] {
        let result = Command::new(env!("CARGO_BIN_EXE_rho"))
            .arg("--project")
            .arg(&project)
            .arg("--database")
            .arg(dir.path().join("state/records.sqlite"))
            .args([
                "invoke",
                "--client-request-id",
                capability,
                "--capability",
                capability,
                "--arguments",
            ])
            .arg(arguments.to_string())
            .output()
            .unwrap();
        assert!(!result.status.success(), "{capability}");
        let error: Value = serde_json::from_slice(&result.stderr).unwrap();
        assert!(
            error["error"].as_str().unwrap().contains(capability),
            "{error}"
        );
    }
    assert_eq!(
        std::fs::read_to_string(project.join("analysis.R")).unwrap(),
        "original\n"
    );
    assert!(!project.join("produced.txt").exists());
    assert!(!dir.path().join("state/runtime").exists());
    assert!(!dir.path().join("state/environment").exists());
}
