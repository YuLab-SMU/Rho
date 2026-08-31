use std::collections::VecDeque;

use rho_execution::{local::ProcessIdentity, reconcile::*};
use rho_protocol::*;

struct Probe {
    observations: VecDeque<ProcessProbeObservation>,
    cancel_result: bool,
    cancel_calls: usize,
}

impl ReconcileProcessProbe for Probe {
    fn observe(&mut self, _identity: &ProcessIdentity) -> ProcessProbeObservation {
        self.observations
            .pop_front()
            .unwrap_or(ProcessProbeObservation::ProbeUnavailable)
    }

    fn cancel_exact(&mut self, _identity: &ProcessIdentity) -> bool {
        self.cancel_calls += 1;
        self.cancel_result
    }
}

fn identity(pid: u32, nonce: &str) -> ProcessIdentity {
    ProcessIdentity {
        pid,
        executable_sha256:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        launch_nonce: nonce.to_string(),
        started_unix_ms: 100,
    }
}

fn ids(label: &str) -> (ExecutionId, OperationId) {
    (
        ExecutionId::new(format!("execution_{label}")).unwrap(),
        OperationId::new(format!("operation_{label}")).unwrap(),
    )
}

#[test]
fn reconcile_distinguishes_never_submitted_spawn_unknown_running_terminal_and_uncertain() {
    let policy = ReconcilePolicy::default();

    let (never_id, never_op) = ids("never");
    let mut never = ExecutionTruthStore::default();
    never.record_intent(never_id.clone(), never_op, RetryClass::NonIdempotent);
    let report = reconcile_execution(
        &mut never,
        &never_id,
        &mut Probe {
            observations: VecDeque::new(),
            cancel_result: false,
            cancel_calls: 0,
        },
        &policy,
    )
    .unwrap();
    assert_eq!(report.state, ReconcileState::NeverSubmitted);

    let (unknown_id, unknown_op) = ids("submitted_unknown");
    let mut unknown = ExecutionTruthStore::default();
    unknown.record_intent(unknown_id.clone(), unknown_op, RetryClass::NonIdempotent);
    unknown.record_spawn_ack(&unknown_id).unwrap();
    let report = reconcile_execution(
        &mut unknown,
        &unknown_id,
        &mut Probe {
            observations: VecDeque::new(),
            cancel_result: false,
            cancel_calls: 0,
        },
        &policy,
    )
    .unwrap();
    assert_eq!(report.state, ReconcileState::SubmittedUnknown);
    assert!(report.safe_next_action.contains("do not replay"));

    let (running_id, running_op) = ids("running");
    let mut running = ExecutionTruthStore::default();
    running.record_intent(running_id.clone(), running_op, RetryClass::NonIdempotent);
    running.record_spawn_ack(&running_id).unwrap();
    running
        .record_handle(&running_id, identity(10, "running"))
        .unwrap();
    let report = reconcile_execution(
        &mut running,
        &running_id,
        &mut Probe {
            observations: [ProcessProbeObservation::ExactRunning].into(),
            cancel_result: false,
            cancel_calls: 0,
        },
        &policy,
    )
    .unwrap();
    assert_eq!(report.state, ReconcileState::Running);

    let report = reconcile_execution(
        &mut running,
        &running_id,
        &mut Probe {
            observations: [ProcessProbeObservation::Missing].into(),
            cancel_result: false,
            cancel_calls: 0,
        },
        &policy,
    )
    .unwrap();
    assert_eq!(report.state, ReconcileState::Uncertain);
    assert_eq!(report.reason_code, "process_missing_is_not_failure");
}

#[test]
fn reconcile_exact_exit_requires_one_unique_terminal_record() {
    let (execution_id, operation_id) = ids("terminal");
    let mut store = ExecutionTruthStore::default();
    store.record_intent(execution_id.clone(), operation_id, RetryClass::PureRead);
    store.record_spawn_ack(&execution_id).unwrap();
    store
        .record_handle(&execution_id, identity(11, "terminal"))
        .unwrap();
    let report = reconcile_execution(
        &mut store,
        &execution_id,
        &mut Probe {
            observations: [ProcessProbeObservation::ExactExitedSuccess].into(),
            cancel_result: false,
            cancel_calls: 0,
        },
        &ReconcilePolicy::default(),
    )
    .unwrap();
    assert_eq!(
        report.state,
        ReconcileState::Terminal(OperationOutcome::Succeeded)
    );
    assert_eq!(
        store
            .record_terminal(
                &execution_id,
                "event_terminal_unique",
                OperationOutcome::Succeeded,
            )
            .unwrap(),
        DurableMutationOutcome::Advanced
    );
    assert_eq!(
        store
            .record_terminal(
                &execution_id,
                "event_terminal_unique",
                OperationOutcome::Succeeded,
            )
            .unwrap(),
        DurableMutationOutcome::Duplicate
    );
    assert_eq!(
        store
            .record_terminal(&execution_id, "event_other", OperationOutcome::Failed,)
            .unwrap_err(),
        ExecutionTruthError::TerminalConflict
    );
}

#[test]
fn reconcile_pid_reuse_never_kills_unrelated_process() {
    let (execution_id, operation_id) = ids("pid_reuse");
    let mut store = ExecutionTruthStore::default();
    store.record_intent(
        execution_id.clone(),
        operation_id,
        RetryClass::NonIdempotent,
    );
    store.record_spawn_ack(&execution_id).unwrap();
    store
        .record_handle(&execution_id, identity(99, "old-start"))
        .unwrap();
    let mut probe = Probe {
        observations: [ProcessProbeObservation::IdentityMismatch].into(),
        cancel_result: true,
        cancel_calls: 0,
    };
    assert_eq!(
        cancel_reconciled_execution(&store, &execution_id, &mut probe).unwrap(),
        ReconcileCancelOutcome::IdentityMismatchUncertain
    );
    assert_eq!(probe.cancel_calls, 0);
}

#[test]
fn reconcile_cancel_and_artifact_collection_are_idempotent() {
    let (execution_id, operation_id) = ids("cancel");
    let mut store = ExecutionTruthStore::default();
    store.record_intent(execution_id.clone(), operation_id, RetryClass::PureRead);
    store.record_spawn_ack(&execution_id).unwrap();
    store
        .record_handle(&execution_id, identity(12, "cancel"))
        .unwrap();
    let mut probe = Probe {
        observations: [ProcessProbeObservation::ExactRunning].into(),
        cancel_result: true,
        cancel_calls: 0,
    };
    assert_eq!(
        cancel_reconciled_execution(&store, &execution_id, &mut probe).unwrap(),
        ReconcileCancelOutcome::CancelledConfirmed
    );
    store
        .record_terminal(
            &execution_id,
            "event_cancelled",
            OperationOutcome::Cancelled,
        )
        .unwrap();
    assert_eq!(
        cancel_reconciled_execution(&store, &execution_id, &mut probe).unwrap(),
        ReconcileCancelOutcome::AlreadyTerminal
    );
    assert_eq!(
        store
            .record_artifact(&execution_id, "artifact_one")
            .unwrap(),
        DurableMutationOutcome::Advanced
    );
    assert_eq!(
        store
            .record_artifact(&execution_id, "artifact_one")
            .unwrap(),
        DurableMutationOutcome::Duplicate
    );
}

#[test]
fn reconcile_kill_matrix_preserves_truth_at_each_boundary() {
    for stage in [
        DurableExecutionStage::IntentRecorded,
        DurableExecutionStage::SpawnAcknowledged,
        DurableExecutionStage::HandleRecorded,
        DurableExecutionStage::RunningObserved,
        DurableExecutionStage::TerminalObserved,
        DurableExecutionStage::OutputsCollected,
    ] {
        let label = format!("kill_{stage:?}").to_ascii_lowercase();
        let (execution_id, operation_id) = ids(&label);
        let mut store = ExecutionTruthStore::default();
        store.record_intent(
            execution_id.clone(),
            operation_id,
            RetryClass::NonIdempotent,
        );
        if stage >= DurableExecutionStage::SpawnAcknowledged {
            store.record_spawn_ack(&execution_id).unwrap();
        }
        if stage >= DurableExecutionStage::HandleRecorded {
            store
                .record_handle(&execution_id, identity(20, &label))
                .unwrap();
        }
        if stage >= DurableExecutionStage::RunningObserved {
            store.record_running(&execution_id).unwrap();
        }
        if stage >= DurableExecutionStage::TerminalObserved {
            store
                .record_terminal(
                    &execution_id,
                    format!("event_{label}"),
                    OperationOutcome::Succeeded,
                )
                .unwrap();
        }
        if stage >= DurableExecutionStage::OutputsCollected {
            store
                .record_artifact(&execution_id, "artifact_kill")
                .unwrap();
        }
        assert_eq!(store.record(&execution_id).unwrap().stage, stage);
    }
}

#[test]
fn reconcile_backoff_is_bounded_and_unknown_remains_uncertain_after_budget() {
    let (execution_id, operation_id) = ids("backoff");
    let mut store = ExecutionTruthStore::default();
    store.record_intent(
        execution_id.clone(),
        operation_id,
        RetryClass::NonIdempotent,
    );
    store.record_spawn_ack(&execution_id).unwrap();
    store
        .record_handle(&execution_id, identity(30, "backoff"))
        .unwrap();
    let policy = ReconcilePolicy {
        max_attempts: 3,
        base_backoff_ms: 100,
        max_backoff_ms: 150,
    };
    let mut observed = Vec::new();
    for _ in 0..3 {
        let report = reconcile_execution(
            &mut store,
            &execution_id,
            &mut Probe {
                observations: [ProcessProbeObservation::ProbeUnavailable].into(),
                cancel_result: false,
                cancel_calls: 0,
            },
            &policy,
        )
        .unwrap();
        assert_eq!(report.state, ReconcileState::Uncertain);
        observed.push(report.next_backoff_ms);
    }
    assert_eq!(observed, vec![Some(100), Some(150), None]);
}

#[test]
fn reconcile_boundary_never_guesses_missing_failed_or_replays_unknown() {
    let (_, does_not_own) = reconcile_boundary();
    assert!(does_not_own.contains(&"missing_means_failed"));
    assert!(does_not_own.contains(&"pid_only_cancel"));
    assert!(does_not_own.contains(&"automatic_unknown_replay"));
    assert!(does_not_own.contains(&"duplicate_terminal_event"));
}
