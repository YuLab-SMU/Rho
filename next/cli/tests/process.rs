#![cfg(unix)]

use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
};

struct Guard(Child);
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn read(reader: &mut impl BufRead) -> Value {
    let mut line = String::new();
    assert!(reader.read_line(&mut line).unwrap() > 0);
    serde_json::from_str(&line).unwrap()
}

#[test]
fn local_process_flows_through_session_journal_and_idempotency() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let mut child = Guard(
        Command::new(env!("CARGO_BIN_EXE_rho-next"))
            .arg("--project")
            .arg(&root)
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
    assert!(
        ready["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|cap| cap["capability"]["id"] == "process.run_local")
    );
    let request = json!({"id":"run","request":{"method":"invoke","params":{
        "client_request_id":"only-once","capability":{"id":"process.run_local","version":1},
        "arguments":{"program":"/bin/sh","args":["-c","printf x >> produced.txt; printf %s \"$RHO_OPERATION_ID\"; printf warning >&2"]}
    }}});
    writeln!(input, "{request}").unwrap();
    input.flush().unwrap();
    let result = read(&mut output);
    assert_eq!(result["result"]["status"], "succeeded", "{result}");
    let record = &result["result"];
    let id = &record["operation"]["operation_id"];
    let bytes: Vec<u8> =
        serde_json::from_value(record["output"]["stdout"]["bytes"].clone()).unwrap();
    assert_eq!(String::from_utf8(bytes).unwrap(), id.as_str().unwrap());
    assert_eq!(record["output"]["stderr"]["bytes"], json!(b"warning"));
    writeln!(input, "{request}").unwrap();
    input.flush().unwrap();
    assert_eq!(read(&mut output)["result"], *record);
    assert_eq!(std::fs::read(root.join("produced.txt")).unwrap(), b"x");
    let get = json!({"id":"get","request":{"method":"get_operation","params":{"operation_id":id}}});
    writeln!(input, "{get}").unwrap();
    input.flush().unwrap();
    assert_eq!(read(&mut output)["result"], *record);
    let events = json!({"id":"events","request":{"method":"subscribe","params":{"after_sequence":0,"limit":100}}});
    writeln!(input, "{events}").unwrap();
    input.flush().unwrap();
    let events = read(&mut output);
    assert!(!events["result"].as_array().unwrap().is_empty());
    drop(input);
    assert!(child.0.wait().unwrap().success());
}
