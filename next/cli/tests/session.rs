use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
};

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn read(reader: &mut impl BufRead) -> Value {
    let mut line = String::new();
    assert!(
        reader.read_line(&mut line).unwrap() > 0,
        "session exited before replying"
    );
    serde_json::from_str(&line).unwrap()
}
fn invocation(frame_id: &str) -> Value {
    json!({"id":frame_id, "request":{"method":"invoke", "params":{
        "client_request_id":frame_id, "capability":{"id":"workspace.run_r","version":1},
        "arguments":{"code":frame_id}
    }}})
}

#[test]
fn one_session_handles_pipelined_frames_and_queries_with_one_runtime() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = ChildGuard(
        Command::new(env!("CARGO_BIN_EXE_rho-next"))
            .arg("--demo")
            .arg("--database")
            .arg(dir.path().join("next.sqlite"))
            .arg("session")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let mut input = child.0.stdin.take().unwrap();
    let mut output = BufReader::new(child.0.stdout.take().unwrap());
    let ready = read(&mut output);
    assert_eq!(ready["type"], "ready");
    let capabilities = ready["capabilities"].as_array().unwrap();
    assert!(
        capabilities
            .iter()
            .any(
                |descriptor| descriptor["capability"]["id"] == "workspace.snapshot"
                    && descriptor["kind"] == "query"
            )
    );
    assert!(
        capabilities.iter().any(
            |descriptor| descriptor["capability"]["id"] == "workspace.run_r"
                && descriptor["kind"] == "operation"
        )
    );
    write!(input, "{}\n{}\n", invocation("one"), invocation("two")).unwrap();
    input.flush().unwrap();
    let a = read(&mut output);
    let b = read(&mut output);
    assert_ne!(a["id"], b["id"]);
    assert_eq!(a["result"]["status"], "succeeded");
    assert_eq!(b["result"]["status"], "succeeded");
    assert_eq!(
        a["result"]["operation"]["target"],
        b["result"]["operation"]["target"]
    );
    assert_ne!(
        a["result"]["output"]["value"]["execution_index"],
        b["result"]["output"]["value"]["execution_index"]
    );
    let op_id = a["result"]["operation"]["operation_id"].clone();
    let query =
        json!({"id":"read","request":{"method":"get_operation","params":{"operation_id":op_id}}});
    // A malformed frame cannot consume the following valid frame.
    writeln!(input, "{{").unwrap();
    writeln!(input, "{query}").unwrap();
    input.flush().unwrap();
    let invalid = read(&mut output);
    assert_eq!(invalid["ok"], false);
    let saved = read(&mut output);
    assert_eq!(saved["id"], "read");
    assert_eq!(saved["result"], a["result"]);
    writeln!(input, "{}", json!({"id":"events", "request":{"method":"subscribe", "params":{"after_sequence":0,"limit":100}}})).unwrap();
    input.flush().unwrap();
    assert!(!read(&mut output)["result"].as_array().unwrap().is_empty());
    drop(input);
    assert!(child.0.wait().unwrap().success());
}

#[test]
fn oversized_session_frame_is_rejected_without_an_operation() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = ChildGuard(
        Command::new(env!("CARGO_BIN_EXE_rho-next"))
            .arg("--demo")
            .arg("--database")
            .arg(dir.path().join("next.sqlite"))
            .arg("session")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let mut input = child.0.stdin.take().unwrap();
    let mut output = BufReader::new(child.0.stdout.take().unwrap());
    read(&mut output);
    let sent = input.write_all(&vec![b'x'; 270_337]);
    assert!(sent.is_ok() || sent.unwrap_err().kind() == std::io::ErrorKind::BrokenPipe);
    drop(input);
    let error = read(&mut output);
    assert_eq!(error["ok"], false);
    assert!(error["error"].as_str().unwrap().contains("byte bound"));
    assert!(child.0.wait().unwrap().success());
}
