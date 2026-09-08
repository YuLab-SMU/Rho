use serde_json::{Value, json};
use std::process::Command;

#[test]
fn independent_cli_processes_reuse_durable_operation_and_query_without_writes() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("next.sqlite");
    let invoke = |code: &str| {
        Command::new(env!("CARGO_BIN_EXE_rho"))
            .arg("--demo")
            .arg("--database")
            .arg(&db)
            .args(["invoke", "--client-request-id", "cli-once", "--code", code])
            .output()
            .unwrap()
    };
    let first = invoke("x <- 1");
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let value: Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(value["operation"]["status"], json!("succeeded"));
    assert_eq!(value["runtime"], json!("deterministic_fake"));
    let repeat = invoke("x <- 1");
    let repeated: Value = serde_json::from_slice(&repeat.stdout).unwrap();
    assert_eq!(repeated, value);
    let conflict = invoke("x <- 2");
    assert!(!conflict.status.success());
    let conflict: Value = serde_json::from_slice(&conflict.stderr).unwrap();
    assert_eq!(conflict["diagnostic"]["code"], "idempotency_conflict");

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
    // Scientific truth is identical. Read navigation is filtered against this
    // read-only Host's available owners, which deliberately do not start R.
    let mut original_record = value["operation"].clone();
    let mut queried_record = queried["operation"].clone();
    let original_reads = original_record
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
    assert!(
        original_reads
            .as_array()
            .unwrap()
            .iter()
            .any(|read| read["capability"]["id"] == "workspace.output_events")
    );
    assert_eq!(before, std::fs::read(&db).unwrap());
}
