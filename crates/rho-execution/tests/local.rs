#![cfg(unix)]

use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt, thread, time::Duration};

use rho_execution::local::*;
use rho_protocol::*;

#[derive(Default)]
struct Recorder {
    intents: usize,
    handles: usize,
    fail_intent: bool,
    fail_handle: bool,
}

impl SubmitIntentRecorder for Recorder {
    fn record_submit_intent(&mut self, _spec: &ValidatedLocalExecutionSpec) -> Result<(), String> {
        if self.fail_intent {
            return Err("intent failure".to_string());
        }
        self.intents += 1;
        Ok(())
    }

    fn record_process_handle(
        &mut self,
        _execution_id: &ExecutionId,
        _identity: &ProcessIdentity,
    ) -> Result<(), String> {
        if self.fail_handle {
            return Err("handle failure".to_string());
        }
        self.handles += 1;
        Ok(())
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    executable: std::path::PathBuf,
    working: std::path::PathBuf,
    staging: std::path::PathBuf,
}

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("approved-worker");
    fs::write(
        &executable,
        r#"#!/bin/sh
mode="$1"
case "$mode" in
  success) echo "stdout-ok"; echo "stderr-ok" >&2; exit 0 ;;
  fail) echo "failure" >&2; exit 7 ;;
  signal) kill -TERM $$ ;;
  flood) i=0; while [ "$i" -lt 100000 ]; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n'; i=$((i+1)); done ;;
  hang) sleep 30 ;;
esac
"#,
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let working = temp.path().join("working");
    fs::create_dir(&working).unwrap();
    fs::write(working.join("input.txt"), "immutable").unwrap();
    fs::set_permissions(working.join("input.txt"), fs::Permissions::from_mode(0o444)).unwrap();
    fs::set_permissions(&working, fs::Permissions::from_mode(0o555)).unwrap();
    let staging = temp.path().join("staging");
    fs::create_dir(&staging).unwrap();
    Fixture {
        _temp: temp,
        executable,
        working,
        staging,
    }
}

fn spec(fixture: &Fixture, id: &str, mode: &str, timeout_ms: u64) -> LocalExecutionSpec {
    LocalExecutionSpec {
        execution_id: ExecutionId::new(format!("execution_{id}")).unwrap(),
        operation_id: OperationId::new(format!("operation_{id}")).unwrap(),
        executable: fixture.executable.clone(),
        executable_sha256: local_executable_digest(&fixture.executable).unwrap(),
        argv: vec![mode.to_string()],
        working_set_root: fixture.working.clone(),
        working_directory: fixture.working.clone(),
        input_artifacts: Vec::new(),
        output_staging: fixture.staging.clone(),
        environment: BTreeMap::from([
            ("HOME".to_string(), fixture.staging.display().to_string()),
            ("TMPDIR".to_string(), fixture.staging.display().to_string()),
            ("R_ENVIRON_USER".to_string(), "/dev/null".to_string()),
            ("R_PROFILE_USER".to_string(), "/dev/null".to_string()),
        ]),
        secret_lease_ids: vec!["secret-lease:operation".to_string()],
        network_profile: "deny".to_string(),
        effect_class: EffectClass::ExternalEffect,
        retry_class: RetryClass::NonIdempotent,
        timeout_ms,
    }
}

fn wait_terminal(
    executor: &mut LocalProcessExecutor,
    execution_id: &ExecutionId,
) -> LocalTerminalObservation {
    for _ in 0..500 {
        if let Some(terminal) = executor.poll(execution_id).unwrap() {
            return terminal.clone();
        }
        thread::sleep(Duration::from_millis(5));
    }
    panic!("local process did not terminate");
}

#[test]
fn local_prepare_accepts_validated_argv_digest_read_only_working_set_and_staging() {
    let fixture = fixture();
    let prepared =
        LocalProcessExecutor::prepare(spec(&fixture, "prepare", "success", 1000)).unwrap();
    assert_eq!(prepared.spec().argv, vec!["success"]);
    assert_eq!(prepared.spec().network_profile, "deny");
    assert_eq!(prepared.spec().secret_lease_ids.len(), 1);
}

#[test]
fn local_rejects_missing_digest_mismatch_shell_and_writable_working_set() {
    let fixture = fixture();
    let mut missing = spec(&fixture, "missing", "success", 1000);
    missing.executable = fixture._temp.path().join("missing");
    assert!(matches!(
        LocalProcessExecutor::prepare(missing),
        Err(LocalExecutorError::ExecutableUnavailable)
    ));
    let mut mismatch = spec(&fixture, "mismatch", "success", 1000);
    mismatch.executable_sha256 =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string();
    assert!(matches!(
        LocalProcessExecutor::prepare(mismatch),
        Err(LocalExecutorError::DigestMismatch)
    ));
    let mut shell = spec(&fixture, "shell", "success", 1000);
    shell.argv = vec!["-c".to_string(), "rm -rf .".to_string()];
    assert!(matches!(
        LocalProcessExecutor::prepare(shell),
        Err(LocalExecutorError::ShellPathRejected)
    ));
    fs::set_permissions(&fixture.working, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(
        LocalProcessExecutor::prepare(spec(&fixture, "writable", "success", 1000)),
        Err(LocalExecutorError::WorkingSetRejected)
    ));
}

#[test]
fn local_submit_records_intent_before_spawn_ack_and_captures_separate_streams() {
    let fixture = fixture();
    let prepared =
        LocalProcessExecutor::prepare(spec(&fixture, "success", "success", 1000)).unwrap();
    let execution_id = prepared.spec().execution_id.clone();
    let mut recorder = Recorder::default();
    let mut executor = LocalProcessExecutor::new();
    let outcome = executor.submit(prepared, &mut recorder).unwrap();
    assert!(matches!(
        outcome,
        LocalSubmitOutcome::SpawnAcknowledged { .. }
    ));
    assert_eq!((recorder.intents, recorder.handles), (1, 1));
    let terminal = wait_terminal(&mut executor, &execution_id);
    assert_eq!(terminal.reason_code, "succeeded");
    assert!(String::from_utf8_lossy(&terminal.stdout).contains("stdout-ok"));
    assert!(String::from_utf8_lossy(&terminal.stderr).contains("stderr-ok"));
    assert!(executor.process_identity(&execution_id).is_some());
}

#[test]
fn local_duplicate_submit_returns_same_identity_and_never_spawns_second_process() {
    let fixture = fixture();
    let prepared =
        LocalProcessExecutor::prepare(spec(&fixture, "duplicate", "hang", 5000)).unwrap();
    let execution_id = prepared.spec().execution_id.clone();
    let mut recorder = Recorder::default();
    let mut executor = LocalProcessExecutor::new();
    let first = executor.submit(prepared.clone(), &mut recorder).unwrap();
    let second = executor.submit(prepared, &mut recorder).unwrap();
    let first_identity = match first {
        LocalSubmitOutcome::SpawnAcknowledged { identity } => identity,
        other => panic!("unexpected {other:?}"),
    };
    assert_eq!(
        second,
        LocalSubmitOutcome::Duplicate {
            identity: first_identity
        }
    );
    assert_eq!(recorder.intents, 1);
    executor.cancel(&execution_id).unwrap();
}

#[test]
fn local_pre_spawn_failure_is_retryable_but_unknown_non_idempotent_after_ack_is_not_replayed() {
    let fixture = fixture();
    let prepared = LocalProcessExecutor::prepare(spec(&fixture, "boundary", "hang", 5000)).unwrap();
    let mut executor = LocalProcessExecutor::new();
    let mut intent_failure = Recorder {
        fail_intent: true,
        ..Recorder::default()
    };
    assert!(matches!(
        executor.submit(prepared.clone(), &mut intent_failure),
        Err(LocalExecutorError::IntentRecordFailed)
    ));
    assert!(replay_after_stage(RetryClass::NonIdempotent, false, false));

    let mut handle_failure = Recorder {
        fail_handle: true,
        ..Recorder::default()
    };
    let execution_id = prepared.spec().execution_id.clone();
    assert!(matches!(
        executor.submit(prepared, &mut handle_failure).unwrap(),
        LocalSubmitOutcome::Uncertain { .. }
    ));
    assert!(!replay_after_stage(RetryClass::NonIdempotent, true, true));
    executor.cancel(&execution_id).unwrap();
}

#[test]
fn local_exit_signal_timeout_and_output_flood_are_truthful_and_bounded() {
    for (id, mode, timeout, expected) in [
        ("fail", "fail", 1000, "nonzero_exit"),
        ("signal", "signal", 1000, "signal"),
        ("timeout", "hang", 20, "timeout"),
        ("flood", "flood", 5000, "succeeded"),
    ] {
        let fixture = fixture();
        let prepared = LocalProcessExecutor::prepare(spec(&fixture, id, mode, timeout)).unwrap();
        let execution_id = prepared.spec().execution_id.clone();
        let mut executor = LocalProcessExecutor::new();
        executor.submit(prepared, &mut Recorder::default()).unwrap();
        let terminal = wait_terminal(&mut executor, &execution_id);
        assert_eq!(terminal.reason_code, expected);
        assert!(terminal.stdout.len() <= MAX_LOCAL_CAPTURE_BYTES);
        assert!(terminal.stderr.len() <= MAX_LOCAL_CAPTURE_BYTES);
        if mode == "flood" {
            assert!(terminal.output_truncated);
        }
    }
}

#[test]
fn local_executor_has_no_interactive_workspace_or_shell_string_path() {
    let source = include_str!("../src/local/mod.rs")
        .split("pub fn local_boundary")
        .next()
        .unwrap();
    for forbidden in [
        "WorkspaceExecutor",
        "run_r",
        "sh -c",
        "Command::new(\"sh\")",
    ] {
        assert!(
            !source.contains(forbidden),
            "local executor leaked {forbidden}"
        );
    }
    let (_, does_not_own) = local_boundary();
    assert!(does_not_own.contains(&"interactive_workspace"));
    assert!(does_not_own.contains(&"automatic_non_idempotent_replay"));
}
