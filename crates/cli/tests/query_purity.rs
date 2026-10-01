use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, Command, Stdio},
};
struct Guard(Child);
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn observer(
    database: &Path,
    project: &Path,
    capability: &str,
    args: Value,
) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_rho"))
        .arg("--database")
        .arg(database)
        .arg("--project")
        .arg(project)
        .args(["query", "--capability", capability, "--arguments"])
        .arg(args.to_string())
        .output()
        .unwrap()
}
#[test]
fn standalone_queries_leave_new_projects_and_missing_databases_uninitialized() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    fs::create_dir(&project).unwrap();
    fs::write(project.join("notes.txt"), "read-only evidence\n").unwrap();
    let database = dir.path().join("unused/state.sqlite");
    for (capability, args) in [
        ("host.overview", json!({})),
        ("host.catalog", json!({"limit":10})),
    ] {
        let result = observer(&database, &project, capability, args);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let reply: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(reply["observation"]["status"], "ready");
    }
    for capability in [
        "project.read_text",
        "output.read_text",
        "workspace.snapshot",
    ] {
        let result = observer(&database, &project, capability, json!({}));
        assert!(!result.status.success(), "{capability}");
        let error: Value = serde_json::from_slice(&result.stderr).unwrap();
        assert!(
            error["error"]
                .as_str()
                .unwrap()
                .contains("existing plugin Host")
        );
    }
    assert!(!database.parent().unwrap().exists());
    assert!(!project.join(".rho").exists());
    assert_eq!(
        fs::read(project.join("notes.txt")).unwrap(),
        b"read-only evidence\n"
    );
}
#[test]
fn query_rejects_runtime_startup_flags_before_creating_any_host_material() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    fs::create_dir(&project).unwrap();
    let database = dir.path().join("unused/state.sqlite");
    for arguments in [
        vec!["--ark", "/unavailable/ark", "--r-home", "/unavailable/R"],
        vec!["--rscript", "/unavailable/Rscript"],
        vec!["--demo"],
    ] {
        let result = Command::new(env!("CARGO_BIN_EXE_rho"))
            .arg("--database")
            .arg(&database)
            .arg("--project")
            .arg(&project)
            .args(arguments)
            .args(["query", "--capability", "host.overview"])
            .output()
            .unwrap();
        assert!(!result.status.success());
        assert!(String::from_utf8_lossy(&result.stderr).contains("unexpected argument"));
        assert!(!database.parent().unwrap().exists());
        assert!(!project.join(".rho").exists());
    }
}
#[test]
fn cli_queries_read_while_a_real_project_host_owns_the_writer_and_project_lease() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    fs::create_dir(&project).unwrap();
    fs::write(project.join("notes.txt"), "live Host owns this project\n").unwrap();
    let database = dir.path().join("state/next.sqlite");
    let mut child = Guard(
        Command::new(env!("CARGO_BIN_EXE_rho"))
            .arg("--database")
            .arg(&database)
            .arg("--project")
            .arg(&project)
            .arg("session")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let mut input = child.0.stdin.take().unwrap();
    let mut reader = BufReader::new(child.0.stdout.take().unwrap());
    let mut line = String::new();
    assert!(reader.read_line(&mut line).unwrap() > 0);
    let ready: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(ready["type"], "ready");
    let before = fs::read(&database).unwrap();
    let result = observer(
        &database,
        &project,
        "operation.list_recent",
        json!({"limit":10}),
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(fs::read(&database).unwrap(), before);
    assert!(child.0.try_wait().unwrap().is_none());
    writeln!(input,"{}",json!({"id":"still-owned","request":{"method":"query_snapshot","params":{"capability":{"id":"plugins.list","version":1},"arguments":{"limit":10}}}})).unwrap();
    input.flush().unwrap();
    line.clear();
    assert!(reader.read_line(&mut line).unwrap() > 0);
    let response: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["ok"], true);
    drop(input);
    assert!(child.0.wait().unwrap().success());
}
