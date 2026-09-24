#![cfg(unix)]

use rho_process_engine::{ProcessTermination, ProcessOptions, run_command};
use std::{
    io::{BufRead, Read, Write},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    net::{TcpListener, TcpStream},
    process::Command,
    sync::watch,
};

fn options() -> ProcessOptions {
    ProcessOptions {
        timeout: Duration::from_secs(5),
        output_limit_bytes: 1024,
        stdin: None,
    }
}
fn shell(script: &str) -> Command {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", script]);
    command
}

#[tokio::test]
async fn exact_binary_output_stdin_and_nonzero_exit() {
    let mut config = options();
    config.stdin = Some(b"input\0bytes".to_vec());
    let report = run_command(
        shell(r#"cat; printf '\377\000A' >&2; exit 7"#),
        config,
        watch::channel(false).1,
    )
    .await
    .unwrap();
    assert_eq!(report.termination, ProcessTermination::Exited);
    assert_eq!(report.exit_code, Some(7));
    assert_eq!(report.stdout.bytes, b"input\0bytes");
    assert_eq!(report.stderr.bytes, [255, 0, 65]);
    assert!(report.stdout.eof && report.stderr.eof);
    assert!(report.stdin_error.is_none());
}

#[tokio::test]
async fn retention_limit_does_not_stop_draining_or_deadlock_child() {
    let mut config = options();
    config.output_limit_bytes = 23;
    let report = run_command(
        shell("head -c 1048576 /dev/zero; head -c 1048576 /dev/zero >&2"),
        config,
        watch::channel(false).1,
    )
    .await
    .unwrap();
    assert_eq!(report.exit_code, Some(0), "{report:?}");
    assert_eq!(report.termination, ProcessTermination::Exited);
    for stream in [&report.stdout, &report.stderr] {
        assert_eq!(stream.bytes, vec![0; 23]);
        assert_eq!(stream.total_bytes, 1048576);
        assert!(stream.eof && stream.truncated);
    }
}

#[tokio::test]
async fn cancellation_before_spawn_never_starts_a_process() {
    let report = run_command(
        Command::new("executable-that-must-not-be-resolved"),
        options(),
        watch::channel(true).1,
    )
    .await
    .unwrap();
    assert_eq!(report.termination, ProcessTermination::Cancelled);
    assert!(report.pid.is_none());
    assert!(!report.cleanup_requested);
}

fn fixture(mode: &str, listener: &TcpListener) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", "child_fixture", "--nocapture"])
        .env("RHO_TEST_CHILD_MODE", mode)
        .env(
            "RHO_TEST_CHILD_ADDRESS",
            listener.local_addr().unwrap().to_string(),
        );
    command
}
async fn ready(listener: &TcpListener) -> BufReader<TcpStream> {
    tokio::time::timeout(Duration::from_secs(3), async {
        let (socket, _) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(socket);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert!(line.trim().parse::<u32>().unwrap() > 0);
        reader
    })
    .await
    .expect("child did not signal readiness")
}
async fn assert_child_stopped(mut socket: BufReader<TcpStream>) {
    let mut rest = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), socket.read_to_end(&mut rest))
        .await
        .expect("descendant still holds its live socket")
        .unwrap();
    assert!(rest.is_empty());
}

#[tokio::test]
async fn cancellation_kills_parent_and_descendant_before_returning() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (cancel, receiver) = watch::channel(false);
    let task = tokio::spawn(run_command(
        fixture("parent", &listener),
        options(),
        receiver,
    ));
    let socket = ready(&listener).await;
    cancel.send(true).unwrap();
    let report = task.await.unwrap().unwrap();
    assert_eq!(
        report.termination,
        ProcessTermination::Cancelled,
        "{report:?}"
    );
    assert!(report.exit_signal.is_some());
    assert!(report.stdout.eof && report.stderr.eof);
    assert_child_stopped(socket).await;
}

#[tokio::test]
async fn timeout_is_confirmed_and_cleans_descendant() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut config = options();
    config.timeout = Duration::from_secs(2);
    let task = tokio::spawn(run_command(
        fixture("parent", &listener),
        config,
        watch::channel(false).1,
    ));
    let socket = ready(&listener).await;
    let report = task.await.unwrap().unwrap();
    assert_eq!(
        report.termination,
        ProcessTermination::TimedOut,
        "{report:?}"
    );
    assert!(report.exit_signal.is_some());
    assert_child_stopped(socket).await;
}

#[tokio::test]
async fn normal_leader_exit_cleans_background_descendant() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let task = tokio::spawn(run_command(
        fixture("leader_exits", &listener),
        options(),
        watch::channel(false).1,
    ));
    let socket = ready(&listener).await;
    let report = task.await.unwrap().unwrap();
    assert_eq!(report.termination, ProcessTermination::Exited, "{report:?}");
    assert_eq!(report.exit_code, Some(0));
    assert_child_stopped(socket).await;
}

#[tokio::test]
async fn dropping_supervision_future_kills_its_group() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let task = tokio::spawn(run_command(
        fixture("parent", &listener),
        options(),
        watch::channel(false).1,
    ));
    let socket = ready(&listener).await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_child_stopped(socket).await;
}

// A real executable fixture, not a fake RuntimeReport. A TCP readiness/EOF
// witness makes cancellation and descendant cleanup observable without polling.
#[test]
fn child_fixture() {
    let Ok(mode) = std::env::var("RHO_TEST_CHILD_MODE") else {
        return;
    };
    if mode == "worker" {
        let mut socket =
            std::net::TcpStream::connect(std::env::var("RHO_TEST_CHILD_ADDRESS").unwrap()).unwrap();
        writeln!(socket, "{}", std::process::id()).unwrap();
        println!("worker-ready");
        std::io::stdout().flush().unwrap();
        let _ = socket.read(&mut [0]);
    } else {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "child_fixture", "--nocapture"])
            .env("RHO_TEST_CHILD_MODE", "worker")
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = std::io::BufReader::new(child.stdout.take().unwrap());
        loop {
            let mut line = String::new();
            assert!(output.read_line(&mut line).unwrap() > 0);
            if line.trim() == "worker-ready" {
                break;
            }
        }
        if mode == "leader_exits" {
            std::process::exit(0)
        }
        let _ = child.wait();
    }
    std::process::exit(0);
}
