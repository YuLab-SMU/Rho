//! Loopback HTTP fixtures validate the CLI transport; scientific ownership is tested in rho-host.
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    process::Command,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
const TOKEN: &str = "5b6c0f85569b452489275d58ae64e61b6b1c1c2d1a11453ab2e5a9f778924780";
#[derive(Debug, Clone)]
struct Received {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Value,
}
fn receive(stream: &mut TcpStream) -> Received {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut reader = BufReader::new(stream);
    let mut first = String::new();
    reader.read_line(&mut first).unwrap();
    let pieces = first.split_whitespace().collect::<Vec<_>>();
    let method = pieces[0].to_owned();
    let path = pieces[1].to_owned();
    let mut headers = vec![];
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        assert!(reader.read_line(&mut line).unwrap() > 0);
        if line == "\r\n" {
            break;
        }
        let (name, value) = line.split_once(':').unwrap();
        let name = name.to_ascii_lowercase();
        let value = value.trim().to_owned();
        if name == "content-length" {
            length = value.parse().unwrap();
        }
        headers.push((name, value));
    }
    assert!(length <= 272 * 1024);
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).unwrap();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    Received {
        method,
        path,
        headers,
        body,
    }
}
fn respond(stream: &mut TcpStream, status: u16, body: Value, extra: &str) {
    let body = serde_json::to_vec(&body).unwrap();
    write!(stream,"HTTP/1.1 {status} fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n",body.len()).unwrap();
    stream.write_all(&body).unwrap();
    stream.flush().unwrap();
}
struct Server {
    port: u16,
    received: Arc<Mutex<Vec<Received>>>,
    task: thread::JoinHandle<()>,
}
fn spawn_server(
    count: usize,
    handler: impl Fn(usize, &Received, &mut TcpStream) + Send + 'static,
) -> Server {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let received = Arc::new(Mutex::new(vec![]));
    let logged = received.clone();
    let task = thread::spawn(move || {
        for index in 0..count {
            let (mut stream, _) = listener.accept().unwrap();
            let request = receive(&mut stream);
            logged.lock().unwrap().push(request.clone());
            handler(index, &request, &mut stream);
        }
    });
    Server {
        port,
        received,
        task,
    }
}
fn url_file(root: &Path, port: u16) -> std::path::PathBuf {
    let path = root.join("private-url");
    fs::write(&path, format!("http://127.0.0.1:{port}/#token={TOKEN}\n")).unwrap();
    path
}
fn command(file: &Path, database: &Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_rho"))
        .arg("--connect-url-file")
        .arg(file)
        .arg("--database")
        .arg(database)
        .arg("--project")
        .arg("/fixture-project")
        .args(args)
        .output()
        .unwrap()
}
fn ensure_no_token(result: &std::process::Output) {
    assert!(!String::from_utf8_lossy(&result.stdout).contains(TOKEN));
    assert!(!String::from_utf8_lossy(&result.stderr).contains(TOKEN));
}
#[test]
fn connected_query_invoke_get_and_typed_control_use_the_existing_host_frame() {
    let server = spawn_server(8, |_, request, stream| {
        if request.path == "/api/info" {
            assert_eq!(request.method, "GET");
            respond(
                stream,
                200,
                json!({"project_root":"/fixture-project","runtime":"plugins","capabilities":[]}),
                "",
            );
        } else {
            assert_eq!(request.path, "/api/host");
            assert_eq!(request.method, "POST");
            assert_eq!(request.body["project_root"], "/fixture-project");
            let id = &request.body["frame"]["id"];
            respond(
                stream,
                200,
                json!({"id":id,"ok":true,"result":{"received":request.body["frame"]["request"]}}),
                "",
            );
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let file = url_file(dir.path(), server.port);
    let database = dir.path().join("never-created/next.sqlite");
    let control=json!({"method":"control","params":{"capability":{"id":"fixture.answer","version":2},"arguments":{"binding":{"instance":"exact"},"arguments":{"value":"用户内容"}}}}).to_string();
    let cases = [
        vec![
            "query",
            "--capability",
            "plugins.list",
            "--arguments",
            "{\"limit\":10}",
        ],
        vec![
            "invoke",
            "--client-request-id",
            "original-request",
            "--capability",
            "fixture.run",
            "--arguments",
            "{\"binding\":{\"instance\":\"exact\"},\"arguments\":{\"code\":\"x <- 42\"}}",
            "--preconditions",
            "[{\"kind\":\"fixture.identity\",\"subject\":\"exact\",\"expected\":\"current\"}]",
        ],
        vec!["get-operation", "original-operation"],
        vec!["request", "--json", control.as_str()],
    ];
    for args in cases {
        let result = command(&file, &database, &args);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        ensure_no_token(&result);
        assert_eq!(
            serde_json::from_slice::<Value>(&result.stdout).unwrap()["mode"],
            "connected_host"
        );
    }
    server.task.join().unwrap();
    assert!(!database.parent().unwrap().exists());
    let received = server.received.lock().unwrap();
    let posted = received
        .iter()
        .filter(|r| r.method == "POST")
        .collect::<Vec<_>>();
    assert_eq!(posted.len(), 4);
    assert_eq!(
        posted
            .iter()
            .map(|r| r.body["frame"]["request"]["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["query_snapshot", "invoke", "get_operation", "control"]
    );
    assert_eq!(
        posted[1].body["frame"]["request"]["params"]["client_request_id"],
        "original-request"
    );
    assert_eq!(
        posted[1].body["frame"]["request"]["params"]["preconditions"][0]["expected"],
        "current"
    );
    for request in received.iter() {
        assert!(
            request
                .headers
                .iter()
                .any(|(key, value)| key == "authorization" && value == &format!("Bearer {TOKEN}"))
        );
        assert!(!request.path.contains(TOKEN));
    }
}
#[test]
fn provided_project_precondition_is_checked_before_any_post() {
    let server = spawn_server(1, |_, _, stream| {
        respond(
            stream,
            200,
            json!({"project_root":"/different-project","runtime":"plugins","capabilities":[]}),
            "",
        )
    });
    let dir = tempfile::tempdir().unwrap();
    let file = url_file(dir.path(), server.port);
    let result = command(
        &file,
        &dir.path().join("unused.sqlite"),
        &[
            "invoke",
            "--client-request-id",
            "must-not-run",
            "--capability",
            "fixture.run",
            "--arguments",
            "{}",
        ],
    );
    assert!(!result.status.success());
    ensure_no_token(&result);
    assert_eq!(
        serde_json::from_slice::<Value>(&result.stderr).unwrap()["diagnostic"]["code"],
        "content_changed"
    );
    server.task.join().unwrap();
    assert_eq!(server.received.lock().unwrap().len(), 1);
}
#[test]
fn a_missing_post_acknowledgement_is_uncertain_and_does_not_replay() {
    let server = spawn_server(2, |index, _, stream| {
        if index == 0 {
            respond(
                stream,
                200,
                json!({"project_root":"/fixture-project","runtime":"plugins","capabilities":[]}),
                "",
            );
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let file = url_file(dir.path(), server.port);
    let result = command(
        &file,
        &dir.path().join("unused.sqlite"),
        &[
            "invoke",
            "--client-request-id",
            "keep-this-request",
            "--capability",
            "fixture.run",
            "--arguments",
            "{}",
        ],
    );
    assert!(!result.status.success());
    ensure_no_token(&result);
    let error: Value = serde_json::from_slice(&result.stderr).unwrap();
    assert_eq!(error["diagnostic"]["code"], "outcome_uncertain");
    assert_eq!(
        error["diagnostic"]["next_reads"][0]["arguments"]["client_request_id"],
        "keep-this-request"
    );
    server.task.join().unwrap();
    assert_eq!(
        server
            .received
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.method == "POST")
            .count(),
        1
    );
}
#[test]
fn redirects_are_never_followed_and_credential_content_is_not_printed() {
    let destination = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    destination.set_nonblocking(true).unwrap();
    let port = destination.local_addr().unwrap().port();
    let server = spawn_server(1, move |_, _, stream| {
        respond(
            stream,
            302,
            json!({"error":"redirect"}),
            &format!("Location: http://127.0.0.1:{port}/#token={TOKEN}\r\n"),
        )
    });
    let dir = tempfile::tempdir().unwrap();
    let file = url_file(dir.path(), server.port);
    let result = command(
        &file,
        &dir.path().join("unused.sqlite"),
        &["query", "--capability", "host.overview"],
    );
    assert!(!result.status.success());
    ensure_no_token(&result);
    server.task.join().unwrap();
    assert!(
        matches!(destination.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock)
    );
    let server = spawn_server(1, |_, _, stream| {
        respond(
            stream,
            200,
            json!({"project_root":"/fixture-project","credential":TOKEN}),
            "",
        )
    });
    let file = url_file(dir.path(), server.port);
    let result = command(
        &file,
        &dir.path().join("unused.sqlite"),
        &["query", "--capability", "host.overview"],
    );
    assert!(!result.status.success());
    ensure_no_token(&result);
    server.task.join().unwrap();
}
#[test]
fn malformed_or_nonloopback_urls_fail_without_echoing_the_private_input() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("private-url");
    for url in [
        format!("http://192.0.2.1:8000/#token={TOKEN}"),
        format!("https://127.0.0.1:8000/#token={TOKEN}"),
        format!("http://user:password@127.0.0.1:8000/#token={TOKEN}"),
        format!("http://127.0.0.1:8000/?token={TOKEN}"),
        format!("http://127.0.0.1:8000/#token={TOKEN}&token=second"),
    ] {
        fs::write(&file, url).unwrap();
        let result = command(
            &file,
            &dir.path().join("unused.sqlite"),
            &["query", "--capability", "host.overview"],
        );
        assert!(!result.status.success());
        ensure_no_token(&result);
        assert_eq!(
            serde_json::from_slice::<Value>(&result.stderr).unwrap()["diagnostic"]["code"],
            "invalid_input"
        );
    }
}

#[test]
fn connected_test_selection_keeps_parent_guard_and_never_opens_a_local_host() {
    let server = spawn_server(2, |index, request, stream| {
        if index == 0 {
            respond(
                stream,
                200,
                json!({"project_root":"/fixture-project","runtime":"plugins","capabilities":[]}),
                "",
            );
        } else {
            assert_eq!(request.body["project_root"], "/fixture-project");
            assert_eq!(request.body["frame"]["test_project"], "test-one");
            respond(
                stream,
                200,
                json!({"id":request.body["frame"]["id"],"ok":true,"result":{"selected":"test-one"}}),
                "",
            );
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let file = url_file(dir.path(), server.port);
    fs::write(
        &file,
        format!(
            "http://127.0.0.1:{}/?plugin-window#token={TOKEN}\n",
            server.port
        ),
    )
    .unwrap();
    let database = dir.path().join("never-created/state.sqlite");
    let result = command(
        &file,
        &database,
        &[
            "--test-project",
            "test-one",
            "query",
            "--capability",
            "plugins.instances",
            "--arguments",
            "{\"limit\":100}",
        ],
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    ensure_no_token(&result);
    server.task.join().unwrap();
    assert!(!database.parent().unwrap().exists());
    let result = command(
        &file,
        &database,
        &[
            "--test-project",
            "../invalid",
            "query",
            "--capability",
            "plugins.instances",
        ],
    );
    assert!(!result.status.success());
    ensure_no_token(&result);
    let result = Command::new(env!("CARGO_BIN_EXE_rho"))
        .args([
            "--test-project",
            "test-one",
            "query",
            "--capability",
            "plugins.instances",
        ])
        .output()
        .unwrap();
    assert!(!result.status.success());
}
