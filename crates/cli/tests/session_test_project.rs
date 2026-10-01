//! Real JSON-lines session frames keep disposable project selection explicit.
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};

#[test]
fn session_frames_select_existing_children_and_never_substitute_the_parent() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    fs::create_dir_all(source.join("dist")).unwrap();
    fs::write(
        source.join("index.html"),
        "<!doctype html><p>Independent session fixture</p>",
    )
    .unwrap();
    fs::copy(source.join("index.html"), source.join("dist/index.html")).unwrap();
    fs::write(source.join("deps.lock"), "No dependencies").unwrap();
    fs::write(
        source.join("BUILD.md"),
        "Copy index.html to dist/index.html",
    )
    .unwrap();
    fs::write(source.join("plugin.json"),json!({"protocol_version":1,"id":"example.session-test","name":"Session test","version":"1","description":"Public session transport fixture","license":"MIT","source":{"files":["index.html"],"lockfiles":["deps.lock"],"build_instructions":"BUILD.md","build":null},"dependencies":{},"requires":[],"views":[{"id":"view","title":"Test","entrypoint":"dist/index.html","state_schema":{},"configuration_schema":{},"resource_kinds":[]}],"capabilities":[],"contexts":[],"backend":null,"configuration_schema":{},"default_configuration":{}}).to_string()).unwrap();
    let db = dir.path().join("state.sqlite");
    let root = dir.path().join("analysis");
    fs::create_dir(&root).unwrap();
    let snapshot = Command::new(env!("CARGO_BIN_EXE_rho"))
        .arg("--database")
        .arg(&db)
        .args(["plugins", "snapshot"])
        .arg(&source)
        .output()
        .unwrap();
    assert!(
        snapshot.status.success(),
        "{}",
        String::from_utf8_lossy(&snapshot.stderr)
    );
    let installed: Value = serde_json::from_slice(&snapshot.stdout).unwrap();
    let installed = &installed["result"];
    let mut child = Command::new(env!("CARGO_BIN_EXE_rho"))
        .arg("--database")
        .arg(&db)
        .arg("--project")
        .arg(&root)
        .args(["--plugins-only", "session"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let output = child.stdout.take().unwrap();
    let (send, receive) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            if send.send(line).is_err() {
                break;
            }
        }
    });
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let read = || -> Value {
            serde_json::from_str(
                &receive
                    .recv_timeout(Duration::from_secs(30))
                    .expect("bounded session reply")
                    .unwrap(),
            )
            .unwrap()
        };
        assert_eq!(read()["type"], "ready");
        let mut input = child.stdin.take().unwrap();
        let mut call = |selection: Option<&str>, request: Value| -> Value {
            writeln!(
                input,
                "{}",
                json!({"id":"frame","test_project":selection,"request":request})
            )
            .unwrap();
            input.flush().unwrap();
            read()
        };
        let invoke = |request: &str, capability: &str, arguments: Value| json!({"method":"invoke","params":{"client_request_id":request,"capability":{"id":capability,"version":1},"arguments":arguments,"preconditions":[]}});
        let create = call(
            None,
            invoke(
                "create",
                "plugins.test_create",
                json!({"name":"stdio test","instances":{"ui":{"plugin":"example.session-test","revision":installed["revision"],"artifact":installed["artifacts"][0],"configuration":{},"dependencies":{}}}}),
            ),
        );
        assert_eq!(create["result"]["status"], "succeeded", "{create}");
        let project = &create["result"]["output"]["project"];
        let id = project["id"].as_str().unwrap();
        let query = json!({"method":"query_snapshot","params":{"capability":{"id":"plugins.instances","version":1},"arguments":{"limit":100}}});
        assert_eq!(call(Some(id), query.clone())["result"]["data"]["total"], 1);
        assert_eq!(call(None, query.clone())["result"]["data"]["total"], 0);
        assert_eq!(call(Some("missing"), query.clone())["ok"], false);
        let stop = call(
            None,
            invoke(
                "stop",
                "plugins.test_stop",
                json!({"id":id,"expected_version":project["version"]}),
            ),
        );
        assert_eq!(stop["result"]["status"], "succeeded", "{stop}");
        assert_eq!(call(Some(id), query)["ok"], false);
        drop(input);
    }));
    if result.is_err() {
        let _ = child.kill();
    }
    let status = child.wait().unwrap();
    reader.join().unwrap();
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
    assert!(status.success());
}
