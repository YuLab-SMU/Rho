#![cfg(unix)]

use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    thread,
    time::{Duration, Instant},
};

use rho_agent_host::process::*;

fn provider_script(root: &Path) -> std::path::PathBuf {
    let path = root.join("provider.sh");
    fs::write(
        &path,
        r#"#!/bin/sh
mode="$1"
case "$mode" in
  normal)
    IFS= read -r request
    printf '%s\n' '{"jsonrpc":"2.0","method":"initialized","params":{"protocolVersion":"1"}}'
    printf '%s\n' "token=${AISDK_PROVIDER_TOKEN-unset}" >&2
    printf '%s\n' "unrelated=${UNRELATED_SECRET-unset}"
    ;;
  hang)
    sleep 30
    ;;
  storm)
    i=0
    while [ "$i" -lt 2000 ]; do
      printf 'diagnostic-%s CANARY_RAW_FRAME\n' "$i" >&2
      i=$((i + 1))
    done
    sleep 30
    ;;
  tree)
    sleep 30 &
    echo "$!" > child.pid
    wait
    ;;
esac
"#,
    )
    .unwrap();
    let mut permissions = fs::metadata(&path).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&path, permissions).unwrap();
    path
}

fn spec(root: &Path, mode: &str) -> ApprovedProviderProcess {
    let executable = provider_script(root);
    ApprovedProviderProcess {
        executable_sha256: executable_digest(&executable).unwrap(),
        executable,
        argv: vec![mode.to_string()],
        working_directory: root.to_path_buf(),
        isolated_root: root.to_path_buf(),
        environment: BTreeMap::from([(
            "AISDK_PROVIDER_TOKEN".to_string(),
            "CANARY_PROVIDER_SECRET".to_string(),
        )]),
    }
}

#[test]
fn process_spawn_uses_digest_containment_and_stripped_environment() {
    unsafe { std::env::set_var("UNRELATED_SECRET", "SHOULD_NOT_INHERIT") };
    let temp = tempfile::tempdir().unwrap();
    let mut supervisor = ProviderSupervisor::spawn(&spec(temp.path(), "normal")).unwrap();
    supervisor.begin_handshake();
    supervisor.send_protocol_frame(b"initialize\n").unwrap();
    let mut frames = Vec::new();
    for _ in 0..100 {
        supervisor.poll();
        frames.extend(std::iter::from_fn(|| supervisor.pop_protocol_frame()));
        if frames.len() >= 2 {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    assert!(
        frames
            .iter()
            .any(|frame| String::from_utf8_lossy(frame).contains("initialized"))
    );
    assert!(
        frames
            .iter()
            .any(|frame| String::from_utf8_lossy(frame).contains("unrelated=unset"))
    );
    let diagnostics = std::iter::from_fn(|| supervisor.pop_diagnostic()).collect::<Vec<_>>();
    assert!(
        diagnostics
            .iter()
            .all(|line| !line.detail.contains("CANARY_PROVIDER_SECRET"))
    );
    supervisor.graceful_close_and_reap(b"close\n", Duration::from_millis(100));
    assert_eq!(supervisor.state(), ProviderProcessState::Reaped);
    assert!(!supervisor.orphan_detected());
    unsafe { std::env::remove_var("UNRELATED_SECRET") };
}

#[test]
fn process_digest_mismatch_and_outside_root_fail_before_spawn() {
    let temp = tempfile::tempdir().unwrap();
    let mut mismatch = spec(temp.path(), "normal");
    mismatch.executable_sha256 =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string();
    assert!(matches!(
        ProviderSupervisor::spawn(&mismatch),
        Err(ProviderProcessError::DigestMismatch)
    ));

    let other = tempfile::tempdir().unwrap();
    let executable = provider_script(other.path());
    let outside = ApprovedProviderProcess {
        executable_sha256: executable_digest(&executable).unwrap(),
        executable,
        argv: vec!["normal".to_string()],
        working_directory: temp.path().to_path_buf(),
        isolated_root: temp.path().to_path_buf(),
        environment: BTreeMap::new(),
    };
    assert!(matches!(
        ProviderSupervisor::spawn(&outside),
        Err(ProviderProcessError::ExecutableOutsideRoot)
    ));
}

#[test]
fn process_handshake_timeout_terminates_and_reaps_protocol_hang() {
    let temp = tempfile::tempdir().unwrap();
    let mut supervisor = ProviderSupervisor::spawn(&spec(temp.path(), "hang")).unwrap();
    supervisor.begin_handshake();
    assert!(matches!(
        supervisor.enforce_handshake_deadline(Instant::now(), Duration::ZERO),
        Err(ProviderProcessError::HandshakeTimeout)
    ));
    assert_eq!(supervisor.state(), ProviderProcessState::Reaped);
}

#[test]
fn process_stderr_storm_is_bounded_reports_drops_and_never_becomes_semantic_log() {
    let temp = tempfile::tempdir().unwrap();
    let mut supervisor = ProviderSupervisor::spawn(&spec(temp.path(), "storm")).unwrap();
    for _ in 0..100 {
        supervisor.poll();
        if supervisor.metrics().stderr_queue_drops > 0 {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    assert!(supervisor.metrics().stderr_queue_drops > 0);
    let diagnostics = std::iter::from_fn(|| supervisor.pop_diagnostic()).collect::<Vec<_>>();
    assert!(diagnostics.len() <= MAX_PROVIDER_QUEUE_ITEMS);
    assert!(
        diagnostics
            .iter()
            .all(|item| item.detail.len() <= MAX_PROVIDER_STDERR_LINE_BYTES)
    );
    supervisor.terminate_and_reap();
    let (_, does_not_own) = process_boundary();
    assert!(does_not_own.contains(&"semantic_log"));
    assert!(does_not_own.contains(&"provider_raw_frame_persistence"));
}

#[test]
fn process_cancel_sent_and_process_dead_are_distinct_and_cancel_race_is_idempotent() {
    let temp = tempfile::tempdir().unwrap();
    let mut supervisor = ProviderSupervisor::spawn(&spec(temp.path(), "hang")).unwrap();
    supervisor.request_cancel(b"cancel\n").unwrap();
    assert_eq!(supervisor.state(), ProviderProcessState::CancelSent);
    supervisor.terminate_and_reap();
    assert_eq!(supervisor.state(), ProviderProcessState::Reaped);
    supervisor.request_cancel(b"cancel\n").unwrap();
    assert_eq!(supervisor.state(), ProviderProcessState::Reaped);
}

#[test]
fn process_drop_terminates_tree_and_reaps_parent() {
    let temp = tempfile::tempdir().unwrap();
    {
        let _supervisor = ProviderSupervisor::spawn(&spec(temp.path(), "tree")).unwrap();
        for _ in 0..100 {
            if temp.path().join("child.pid").exists() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
    let child_pid = fs::read_to_string(temp.path().join("child.pid")).unwrap();
    let status = std::process::Command::new("/bin/kill")
        .args(["-0", child_pid.trim()])
        .status()
        .unwrap();
    assert!(
        !status.success(),
        "provider process tree child survived supervisor drop"
    );
}

#[test]
fn process_spawn_failure_and_forbidden_environment_fail_closed() {
    let temp = tempfile::tempdir().unwrap();
    let mut forbidden = spec(temp.path(), "normal");
    forbidden
        .environment
        .insert("DATABASE_URL".to_string(), "CANARY_DB".to_string());
    assert!(matches!(
        ProviderSupervisor::spawn(&forbidden),
        Err(ProviderProcessError::ForbiddenEnvironment)
    ));

    let mut missing = spec(temp.path(), "normal");
    missing.executable = temp.path().join("missing-provider");
    assert!(matches!(
        ProviderSupervisor::spawn(&missing),
        Err(ProviderProcessError::SpawnFailed(_))
    ));
}
