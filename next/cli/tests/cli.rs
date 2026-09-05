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
    assert!(!invoke("x <- 2").status.success());

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
    assert_eq!(queried["operation"], value["operation"]);
    assert_eq!(before, std::fs::read(&db).unwrap());
}
