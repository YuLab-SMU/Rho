use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};

#[test]
fn project_only_cli_applies_and_reads_files_without_starting_r() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("analysis.R"), "a\n").unwrap();
    let db = dir.path().join("state/next.sqlite");
    let patch = "diff --git a/analysis.R b/analysis.R\n--- a/analysis.R\n+++ b/analysis.R\n@@ -1 +1 @@\n-a\n+b\n";
    let output = Command::new(env!("CARGO_BIN_EXE_rho"))
        .arg("--database")
        .arg(&db)
        .arg("--project")
        .arg(&root)
        .args([
            "invoke",
            "--client-request-id",
            "project-cli",
            "--capability",
            "project.apply_patch",
            "--arguments",
        ])
        .arg(json!({"patch":patch}).to_string())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["runtime"], "project");
    assert_eq!(result["operation"]["status"], "succeeded");
    assert_eq!(
        std::fs::read_to_string(root.join("analysis.R")).unwrap(),
        "b\n"
    );
    let mut child = Command::new(env!("CARGO_BIN_EXE_rho"))
        .arg("--database")
        .arg(&db)
        .arg("--project")
        .arg(&root)
        .arg("session")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let ready: Value = serde_json::from_str(&line).unwrap();
    // The instance contract is published up front; liveness is a separate observation.
    assert!(
        ready["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["capability"]["id"] == "runtime.instances")
    );
    writeln!(
        input,
        "{}",
        json!({"id":"instances","request":{"method":"query_snapshot","params":{
            "capability":{"id":"runtime.instances","version":1},"arguments":{"limit":50}
        }}})
    )
    .unwrap();
    input.flush().unwrap();
    line.clear();
    reader.read_line(&mut line).unwrap();
    let instances: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(instances["result"]["status"], "ready");
    assert!(
        instances["result"]["data"]["instances"]
            .as_array()
            .unwrap()
            .iter()
            .all(|instance| instance["native_session_id"].is_null()),
        "a project-only CLI session must not start R: {instances}"
    );
    writeln!(
        input,
        "{}",
        json!({"id":"read","request":{"method":"query_snapshot","params":{
            "capability":{"id":"project.read_file","version":1},"arguments":{"path":"analysis.R"}
        }}})
    )
    .unwrap();
    input.flush().unwrap();
    line.clear();
    reader.read_line(&mut line).unwrap();
    let page: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(page["result"]["status"], "ready");
    assert_eq!(page["result"]["data"]["bytes"], json!([98, 10]));
    drop(input);
    assert!(child.wait().unwrap().success());
}
