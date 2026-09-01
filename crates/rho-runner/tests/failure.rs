use rho_protocol::*;
use rho_runner::{
    journal::{RunnerJobRecord, RunnerJobState, RunnerJournal},
    protocol::{
        MAX_RUNNER_FRAME_BYTES, RunnerAuthKey, RunnerProtocolError, RunnerRequest,
        decode_authenticated_request, encode_authenticated_request,
    },
};

fn record() -> RunnerJobRecord {
    RunnerJobRecord {
        execution_id: ExecutionId::new("execution_failure_journal").unwrap(),
        operation_id: OperationId::new("operation_failure_journal").unwrap(),
        spec_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .to_string(),
        staging_manifest_digest:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string(),
        environment_receipt_digest:
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".to_string(),
        execution_profile_digest:
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd".to_string(),
        repository_profile_digest:
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".to_string(),
        staging_root: "/runner/staging/execution_failure_journal".to_string(),
        command_id: "analysis".to_string(),
        argv: vec!["input".to_string()],
        remote_job_id: "remote_job_failure".to_string(),
        state: RunnerJobState::Prepared,
        process_handle: None,
        terminal_reason_code: None,
        artifact_manifest_digests: Vec::new(),
    }
}

#[test]
fn failure_runner_restart_preserves_prepared_submitted_terminal_and_artifact_truth() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("journal.json");
    let mut journal = RunnerJournal::open(&path).unwrap();
    let record = record();
    journal.prepare(record.clone()).unwrap();
    journal
        .update(&record.operation_id, |record| {
            record.state = RunnerJobState::Succeeded;
            record.terminal_reason_code = Some("process_exit_success".to_string());
            record.artifact_manifest_digests.push(
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                    .to_string(),
            );
        })
        .unwrap();
    drop(journal);
    let restarted = RunnerJournal::open(&path).unwrap();
    let restored = restarted.by_operation(&record.operation_id).unwrap();
    assert_eq!(restored.state, RunnerJobState::Succeeded);
    assert_eq!(
        restored.terminal_reason_code.as_deref(),
        Some("process_exit_success")
    );
    assert_eq!(restored.artifact_manifest_digests.len(), 1);
}

#[test]
fn failure_duplicate_operation_is_idempotent_but_conflicting_spec_is_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let mut journal = RunnerJournal::open(temp.path().join("journal.json")).unwrap();
    let record = record();
    assert!(!journal.prepare(record.clone()).unwrap().1);
    assert!(journal.prepare(record.clone()).unwrap().1);
    let mut conflict = record;
    conflict.spec_digest =
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".to_string();
    assert!(journal.prepare(conflict).is_err());
    assert_eq!(journal.records().count(), 1);
}

#[test]
fn failure_malformed_oversized_and_wrong_auth_frames_never_decode_to_effect() {
    let key = RunnerAuthKey::new(vec![1; 32]).unwrap();
    assert_eq!(
        decode_authenticated_request(b"{", &key).unwrap_err(),
        RunnerProtocolError::Malformed
    );
    assert_eq!(
        decode_authenticated_request(&vec![0; MAX_RUNNER_FRAME_BYTES + 1], &key).unwrap_err(),
        RunnerProtocolError::FrameTooLarge
    );
    let bytes = encode_authenticated_request(
        "request_failure_auth",
        RunnerRequest::Status {
            execution_id: ExecutionId::new("execution_failure_auth").unwrap(),
        },
        &key,
    )
    .unwrap();
    let wrong = RunnerAuthKey::new(vec![2; 32]).unwrap();
    assert_eq!(
        decode_authenticated_request(&bytes, &wrong).unwrap_err(),
        RunnerProtocolError::Authentication
    );
}
