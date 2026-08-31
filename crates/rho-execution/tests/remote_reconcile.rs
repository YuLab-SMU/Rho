use std::collections::{BTreeSet, VecDeque};

use rho_execution::remote_reconcile::*;
use rho_protocol::*;

#[derive(Default)]
struct RunnerPort {
    submit_calls: usize,
    submit_results: VecDeque<Result<RemoteSubmitAck, RemotePortError>>,
    query_results: VecDeque<Result<RunnerRemoteTruth, RemotePortError>>,
    cancel_calls: usize,
    collect_calls: usize,
}

impl RunnerRemotePort for RunnerPort {
    fn submit_once(
        &mut self,
        _operation_id: &OperationId,
    ) -> Result<RemoteSubmitAck, RemotePortError> {
        self.submit_calls += 1;
        self.submit_results
            .pop_front()
            .unwrap_or(Err(RemotePortError::Disconnected))
    }

    fn query_operation(
        &mut self,
        _operation_id: &OperationId,
    ) -> Result<RunnerRemoteTruth, RemotePortError> {
        self.query_results
            .pop_front()
            .unwrap_or(Err(RemotePortError::Disconnected))
    }

    fn cancel_once(
        &mut self,
        _runner_job_id: &str,
        _request_id: &str,
    ) -> Result<(), RemotePortError> {
        self.cancel_calls += 1;
        Ok(())
    }

    fn collect_once(
        &mut self,
        _runner_job_id: &str,
        _request_id: &str,
    ) -> Result<(), RemotePortError> {
        self.collect_calls += 1;
        Ok(())
    }
}

#[derive(Default)]
struct SchedulerPort {
    results: VecDeque<Result<Option<SchedulerRemoteTruth>, RemotePortError>>,
}

impl SchedulerRemotePort for SchedulerPort {
    fn query_scheduler(
        &mut self,
        _scheduler_job_id: &str,
    ) -> Result<Option<SchedulerRemoteTruth>, RemotePortError> {
        self.results.pop_front().unwrap_or(Ok(None))
    }
}

#[derive(Default)]
struct ArtifactPort {
    results: VecDeque<Result<RemoteArtifactTruth, RemotePortError>>,
}

impl RemoteArtifactPort for ArtifactPort {
    fn query_artifacts(
        &mut self,
        _runner_job_id: &str,
    ) -> Result<RemoteArtifactTruth, RemotePortError> {
        self.results
            .pop_front()
            .unwrap_or(Err(RemotePortError::Disconnected))
    }
}

fn ids(label: &str) -> (ExecutionId, OperationId) {
    (
        ExecutionId::new(format!("execution_remote_{label}")).unwrap(),
        OperationId::new(format!("operation_remote_{label}")).unwrap(),
    )
}

fn runner_truth(stage: RemoteStage, outcome: Option<OperationOutcome>) -> RunnerRemoteTruth {
    RunnerRemoteTruth {
        operation_found: true,
        runner_job_id: Some("runner_job_1".to_string()),
        scheduler_job_id: Some("slurm_1".to_string()),
        state: stage,
        terminal_outcome: outcome,
        terminal_event_id: outcome.map(|_| "event_runner_terminal".to_string()),
        artifact_manifest_digests: BTreeSet::new(),
    }
}

#[test]
fn remote_reconcile_ack_drop_never_resubmits_non_idempotent_and_recovers_marker() {
    let (execution_id, operation_id) = ids("ack_drop");
    let mut reconciler = RemoteReconciler::new();
    reconciler.record_intent(
        execution_id.clone(),
        operation_id,
        RetryClass::NonIdempotent,
    );
    let mut runner = RunnerPort {
        submit_results: [Err(RemotePortError::AckLost)].into(),
        query_results: [Ok(runner_truth(RemoteStage::Queued, None))].into(),
        ..RunnerPort::default()
    };
    let first = reconciler
        .ensure_submit(&execution_id, &mut runner)
        .unwrap();
    assert_eq!(first.stage, RemoteStage::SubmittedUnknown);
    let second = reconciler
        .ensure_submit(&execution_id, &mut runner)
        .unwrap();
    assert_eq!(second.stage, RemoteStage::Queued);
    assert_eq!(runner.submit_calls, 1);
}

#[test]
fn remote_reconcile_hierarchy_runner_then_scheduler_then_artifact_manifest_converges() {
    let (execution_id, operation_id) = ids("hierarchy");
    let mut reconciler = RemoteReconciler::new();
    reconciler.record_intent(execution_id.clone(), operation_id, RetryClass::PureRead);
    let mut submit_runner = RunnerPort {
        submit_results: [Ok(RemoteSubmitAck {
            runner_job_id: "runner_job_1".to_string(),
            scheduler_job_id: Some("slurm_1".to_string()),
        })]
        .into(),
        ..RunnerPort::default()
    };
    reconciler
        .ensure_submit(&execution_id, &mut submit_runner)
        .unwrap();

    let mut runner = RunnerPort {
        query_results: [
            Err(RemotePortError::Disconnected),
            Ok(runner_truth(
                RemoteStage::Terminal,
                Some(OperationOutcome::Succeeded),
            )),
        ]
        .into(),
        ..RunnerPort::default()
    };
    let mut scheduler = SchedulerPort {
        results: [Ok(Some(SchedulerRemoteTruth {
            scheduler_job_id: "slurm_1".to_string(),
            state: RemoteStage::Running,
            terminal_outcome: None,
            accounting_event_id: None,
        }))]
        .into(),
    };
    let mut artifacts = ArtifactPort::default();
    let running = reconciler
        .reconcile(
            &execution_id,
            &mut runner,
            &mut scheduler,
            &mut artifacts,
            &RemoteReconcilePolicy::default(),
        )
        .unwrap();
    assert_eq!(running.stage, RemoteStage::Running);

    artifacts.results.push_back(Ok(RemoteArtifactTruth {
        complete: true,
        digests: BTreeSet::from([ArtifactDigest::new(
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap()]),
    }));
    let complete = reconciler
        .reconcile(
            &execution_id,
            &mut runner,
            &mut scheduler,
            &mut artifacts,
            &RemoteReconcilePolicy::default(),
        )
        .unwrap();
    assert_eq!(complete.stage, RemoteStage::ArtifactsCommitted);
    assert_eq!(
        reconciler
            .record(&execution_id)
            .unwrap()
            .artifact_digests
            .len(),
        1
    );
}

#[test]
fn remote_reconcile_runner_kill_login_reboot_sacct_lag_remain_uncertain_with_safe_action() {
    let (execution_id, operation_id) = ids("long_unknown");
    let mut reconciler = RemoteReconciler::new();
    reconciler.record_intent(
        execution_id.clone(),
        operation_id,
        RetryClass::NonIdempotent,
    );
    let mut runner = RunnerPort {
        submit_results: [Ok(RemoteSubmitAck {
            runner_job_id: "runner_job_unknown".to_string(),
            scheduler_job_id: Some("slurm_unknown".to_string()),
        })]
        .into(),
        query_results: [
            Err(RemotePortError::Disconnected),
            Err(RemotePortError::Disconnected),
        ]
        .into(),
        ..RunnerPort::default()
    };
    reconciler
        .ensure_submit(&execution_id, &mut runner)
        .unwrap();
    let policy = RemoteReconcilePolicy {
        max_attempts: 2,
        base_backoff_ms: 10,
        max_backoff_ms: 10,
    };
    let mut scheduler = SchedulerPort::default();
    let mut artifacts = ArtifactPort::default();
    let first = reconciler
        .reconcile(
            &execution_id,
            &mut runner,
            &mut scheduler,
            &mut artifacts,
            &policy,
        )
        .unwrap();
    assert!(matches!(
        first.stage,
        RemoteStage::Queued | RemoteStage::Uncertain
    ));
    let second = reconciler
        .reconcile(
            &execution_id,
            &mut runner,
            &mut scheduler,
            &mut artifacts,
            &policy,
        )
        .unwrap();
    assert_eq!(second.next_backoff_ms, None);
    assert!(
        second.safe_operator_action.contains("do not replay")
            || second.safe_operator_action.contains("reconnect")
    );
}

#[test]
fn remote_reconcile_duplicate_submit_cancel_collect_never_produces_second_effect() {
    let (execution_id, operation_id) = ids("dedupe");
    let mut reconciler = RemoteReconciler::new();
    reconciler.record_intent(execution_id.clone(), operation_id, RetryClass::PureRead);
    let mut runner = RunnerPort {
        submit_results: [Ok(RemoteSubmitAck {
            runner_job_id: "runner_job_dedupe".to_string(),
            scheduler_job_id: None,
        })]
        .into(),
        query_results: [Ok(runner_truth(RemoteStage::Running, None))].into(),
        ..RunnerPort::default()
    };
    reconciler
        .ensure_submit(&execution_id, &mut runner)
        .unwrap();
    reconciler
        .ensure_submit(&execution_id, &mut runner)
        .unwrap();
    assert_eq!(runner.submit_calls, 1);
    assert!(
        reconciler
            .cancel_once(&execution_id, "cancel_1", &mut runner)
            .unwrap()
    );
    assert!(
        !reconciler
            .cancel_once(&execution_id, "cancel_2", &mut runner)
            .unwrap()
    );
    assert!(
        reconciler
            .collect_once(&execution_id, "collect_1", &mut runner)
            .unwrap()
    );
    assert!(
        !reconciler
            .collect_once(&execution_id, "collect_2", &mut runner)
            .unwrap()
    );
    assert_eq!(runner.cancel_calls, 1);
    assert_eq!(runner.collect_calls, 1);
}

#[test]
fn remote_reconcile_terminal_conflict_emits_p0_and_never_silently_rewrites() {
    let (execution_id, operation_id) = ids("conflict");
    let mut reconciler = RemoteReconciler::new();
    reconciler.record_intent(execution_id.clone(), operation_id, RetryClass::PureRead);
    let mut submit = RunnerPort {
        submit_results: [Ok(RemoteSubmitAck {
            runner_job_id: "runner_conflict".to_string(),
            scheduler_job_id: Some("slurm_conflict".to_string()),
        })]
        .into(),
        ..RunnerPort::default()
    };
    reconciler
        .ensure_submit(&execution_id, &mut submit)
        .unwrap();
    let mut failure = runner_truth(RemoteStage::Terminal, Some(OperationOutcome::Failed));
    failure.terminal_event_id = Some("event_failure".to_string());
    let mut runner = RunnerPort {
        query_results: [
            Ok(failure),
            Ok({
                let mut success =
                    runner_truth(RemoteStage::Terminal, Some(OperationOutcome::Succeeded));
                success.terminal_event_id = Some("event_later_success".to_string());
                success
            }),
        ]
        .into(),
        ..RunnerPort::default()
    };
    let mut scheduler = SchedulerPort::default();
    let mut artifacts = ArtifactPort::default();
    reconciler
        .reconcile(
            &execution_id,
            &mut runner,
            &mut scheduler,
            &mut artifacts,
            &RemoteReconcilePolicy::default(),
        )
        .unwrap();
    let conflict = reconciler
        .reconcile(
            &execution_id,
            &mut runner,
            &mut scheduler,
            &mut artifacts,
            &RemoteReconcilePolicy::default(),
        )
        .unwrap();
    assert_eq!(conflict.stage, RemoteStage::Conflict);
    let diagnostic = conflict.diagnostic.unwrap();
    assert_eq!(diagnostic.priority, "p0");
    assert!(diagnostic.causation_required);
    assert_eq!(diagnostic.prior_event_id, "event_failure");
    assert_eq!(diagnostic.conflicting_event_id, "event_later_success");
}

#[test]
fn remote_reconcile_boundary_excludes_agent_plan_provider_session_and_unknown_replay() {
    let (_, does_not_own) = remote_reconcile_boundary();
    assert!(does_not_own.contains(&"duplicate_remote_effect"));
    assert!(does_not_own.contains(&"unknown_non_idempotent_submit"));
    assert!(does_not_own.contains(&"silent_terminal_rewrite"));
    assert!(does_not_own.contains(&"agent_plan"));
    assert!(does_not_own.contains(&"provider_session"));
}
