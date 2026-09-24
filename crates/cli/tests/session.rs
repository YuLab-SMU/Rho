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
        Command::new(env!("CARGO_BIN_EXE_rho"))
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
        Command::new(env!("CARGO_BIN_EXE_rho"))
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

#[path = "../../host/tests/fixtures/plugins.rs"]
mod fixture;

// Replies can complete in any order. A bounded reader makes a blocked control a
// test failure rather than leaving an orphaned native fixture indefinitely.
struct Replies {
    receiver: std::sync::mpsc::Receiver<Value>,
    saved: std::collections::BTreeMap<String, Value>,
}
impl Replies {
    fn new(output: impl std::io::Read + Send + 'static) -> Self {
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let Ok(value) = serde_json::from_str(&line) else {
                    break;
                };
                if sender.send(value).is_err() {
                    break;
                }
            }
        });
        Self {
            receiver,
            saved: Default::default(),
        }
    }
    fn get(&mut self, id: &str) -> Value {
        if let Some(value) = self.saved.remove(id) {
            return value;
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let value = self
                .receiver
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .expect("session reply deadline");
            let received = value["id"].as_str().expect("named session reply");
            if received == id {
                return value;
            }
            assert!(self.saved.insert(received.into(), value).is_none());
        }
    }
}
fn send(input: &mut impl Write, id: &str, method: &str, params: Value) {
    writeln!(
        input,
        "{}",
        json!({"id":id,"request":{"method":method,"params":params}})
    )
    .unwrap();
    input.flush().unwrap();
}
#[test]
fn external_plugin_controls_and_queries_remain_live_when_execution_is_full() {
    use rho_plugins::{PluginRepository, backend_target, repository_path};
    let dir = tempfile::tempdir().unwrap();
    let archive = fixture::package(&dir.path().join("package"), "1.0.0", false);
    let db = dir.path().join("state.sqlite");
    PluginRepository::open(&repository_path(&db))
        .unwrap()
        .import(&archive)
        .unwrap();
    let project = dir.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let mut child = ChildGuard(
        Command::new(env!("CARGO_BIN_EXE_rho"))
            .arg("--database")
            .arg(&db)
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
    let mut replies = Replies::new(child.0.stdout.take().unwrap());
    assert_eq!(
        replies
            .receiver
            .recv_timeout(std::time::Duration::from_secs(120))
            .unwrap()["type"],
        "ready"
    );
    send(
        &mut input,
        "activate",
        "invoke",
        json!({"client_request_id":"activate","capability":{"id":"plugins.activate","version":1},
        "arguments":{"revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":backend_target(),"alias":"queue-test","configuration":{}}}),
    );
    let activated = replies.get("activate");
    assert_eq!(activated["result"]["status"], "succeeded", "{activated}");
    let instance = activated["result"]["output"]["instance"]["identity"].clone();
    let mut bindings = std::collections::BTreeMap::new();
    for (cap, version) in [
        ("fixture.run", 1),
        ("fixture.read", 1),
        ("fixture.answer", 2),
    ] {
        send(
            &mut input,
            cap,
            "query_snapshot",
            json!({"capability":{"id":"plugins.resolve","version":1},"arguments":{"capability":{"id":cap,"version":version},"instance":instance}}),
        );
        let reply = replies.get(cap);
        assert_eq!(reply["ok"], true, "{reply}");
        bindings.insert(cap, reply["result"]["data"].clone());
    }
    let call = |cap: &str, version, arguments: Value| json!({"capability":{"id":cap,"version":version},"arguments":{"binding":bindings[cap],"arguments":arguments}});
    for n in 0..32 {
        let id = format!("held-{n}");
        let mut params = call("fixture.run", 1, json!({"action":"hold"}));
        params["client_request_id"] = json!(id);
        send(&mut input, &id, "invoke", params);
    }
    let mut overflow = call("fixture.run", 1, json!({"action":"hold"}));
    overflow["client_request_id"] = json!("overflow");
    send(&mut input, "overflow", "invoke", overflow);
    assert!(
        replies.get("overflow")["error"]
            .as_str()
            .unwrap()
            .contains("execution pool")
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        send(
            &mut input,
            "count",
            "query_snapshot",
            call("fixture.read", 1, json!({"action":"pending_count"})),
        );
        let reply = replies.get("count");
        assert_eq!(reply["ok"], true, "{reply}");
        if reply["result"]["data"]["operations"] == 32 {
            break;
        }
        assert!(std::time::Instant::now() < deadline);
    }
    for n in 0..16 {
        send(
            &mut input,
            &format!("read-{n}"),
            "query_snapshot",
            call("fixture.read", 1, json!({"action":"hold_read"})),
        );
    }
    send(
        &mut input,
        "read-overflow",
        "query_snapshot",
        call("fixture.read", 1, json!({})),
    );
    assert!(
        replies.get("read-overflow")["error"]
            .as_str()
            .unwrap()
            .contains("query pool")
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        send(
            &mut input,
            "read-count",
            "control",
            call(
                "fixture.answer",
                2,
                json!({"value":"","action":"reads_full"}),
            ),
        );
        let reply = replies.get("read-count");
        assert_eq!(reply["ok"], true, "{reply}");
        if reply["result"]["submitted"] == true {
            break;
        }
        assert!(std::time::Instant::now() < deadline);
    }
    send(
        &mut input,
        "slow-control",
        "control",
        call("fixture.answer", 2, json!({"value":"","action":"hold"})),
    );
    // Duplicate detection applies while a control is awaiting its owner reply.
    send(
        &mut input,
        "slow-control",
        "control",
        call("fixture.answer", 2, json!({"value":""})),
    );
    assert!(
        replies.get("slow-control")["error"]
            .as_str()
            .unwrap()
            .contains("duplicate")
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        send(
            &mut input,
            "control-count",
            "control",
            call(
                "fixture.answer",
                2,
                json!({"value":"","action":"controls_pending"}),
            ),
        );
        let reply = replies.get("control-count");
        assert_eq!(reply["ok"], true, "{reply}");
        if reply["result"]["submitted"] == true {
            break;
        }
        assert!(std::time::Instant::now() < deadline);
    }
    send(
        &mut input,
        "finish-control",
        "control",
        call("fixture.answer", 2, json!({"value":"","action":"finish"})),
    );
    assert_eq!(replies.get("finish-control")["result"]["submitted"], true);
    assert_eq!(replies.get("slow-control")["result"]["submitted"], true);
    for n in 0..16 {
        assert_eq!(
            replies.get(&format!("read-{n}"))["result"]["data"]["finished"],
            true
        );
    }
    send(
        &mut input,
        "finish-work",
        "query_snapshot",
        call("fixture.read", 1, json!({"action":"finish"})),
    );
    assert_eq!(replies.get("finish-work")["ok"], true);
    // EOF drains original accepted work even when no client can submit more.
    drop(input);
    for n in 0..32 {
        assert_eq!(
            replies.get(&format!("held-{n}"))["result"]["status"],
            "succeeded"
        );
    }
    assert!(child.0.wait().unwrap().success());
}
